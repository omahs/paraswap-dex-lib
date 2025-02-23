import _ from 'lodash';
import { Contract } from 'web3-eth-contract';
import { AbiItem } from 'web3-utils';
import { Interface } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import { Log, Logger, BlockHeader, Address } from '../../types';
import {
  InitializeStateOptions,
  StatefulEventSubscriber,
} from '../../stateful-event-subscriber';
import { IDexHelper } from '../../dex-helper/idex-helper';
import {
  PoolState,
  TickBitMapMappings,
  TickInfo,
  TickInfoMappings,
} from './types';
import UniswapV3PoolABI from '../../abi/uniswap-v3/UniswapV3Pool.abi.json';
import { bigIntify, catchParseLogError } from '../../utils';
import { uniswapV3Math } from './contract-math/uniswap-v3-math';
import { NumberAsString } from '@paraswap/core';
import {
  OUT_OF_RANGE_ERROR_POSTFIX,
  TICK_BITMAP_BUFFER,
  TICK_BITMAP_TO_USE,
} from './constants';
import { TickBitMap } from './contract-math/TickBitMap';
import { ERC20EventSubscriber } from '../../lib/generics-events-subscribers/erc20-event-subscriber';
import { getERC20Subscriber } from '../../lib/generics-events-subscribers/erc20-event-subscriber-factory';

export class UniswapV3EventPool extends StatefulEventSubscriber<PoolState> {
  handlers: {
    [event: string]: (
      event: any,
      pool: PoolState,
      log: Log,
      blockHeader: Readonly<BlockHeader>,
    ) => PoolState;
  } = {};

  logDecoder: (log: Log) => any;

  readonly token0: Address;

  readonly token1: Address;

  private _poolAddress?: Address;

  private _stateRequestCallData?: {
    funcName: string;
    params: unknown[];
  };

  public readonly poolIface = new Interface(UniswapV3PoolABI);

  public readonly feeCodeAsString;

  public token0sub: ERC20EventSubscriber;
  public token1sub: ERC20EventSubscriber;

  constructor(
    readonly dexHelper: IDexHelper,
    parentName: string,
    readonly stateMultiContract: Contract,
    protected readonly factoryAddress: Address,
    public readonly feeCode: bigint,
    token0: Address,
    token1: Address,
    logger: Logger,
    mapKey: string = '',
  ) {
    super(
      parentName,
      `${token0}_${token1}_${feeCode}`,
      dexHelper,
      logger,
      true,
      mapKey,
    );
    this.feeCodeAsString = feeCode.toString();
    this.token0 = token0.toLowerCase();
    this.token1 = token1.toLowerCase();
    this.logDecoder = (log: Log) => this.poolIface.parseLog(log);
    this.addressesSubscribed = new Array<Address>(1);

    this.token0sub = getERC20Subscriber(this.dexHelper, this.token0);
    this.token1sub = getERC20Subscriber(this.dexHelper, this.token1);

    // Add handlers
    this.handlers['Swap'] = this.handleSwapEvent.bind(this);
    this.handlers['Burn'] = this.handleBurnEvent.bind(this);
    this.handlers['Mint'] = this.handleMintEvent.bind(this);
    this.handlers['SetFeeProtocol'] = this.handleSetFeeProtocolEvent.bind(this);
    this.handlers['IncreaseObservationCardinalityNext'] =
      this.handleIncreaseObservationCardinalityNextEvent.bind(this);
  }

  get poolAddress() {
    if (this._poolAddress === undefined) {
      throw new Error(
        `${this.parentName}: First call generateState at least one time before requesting poolAddress`,
      );
    }
    return this._poolAddress;
  }

  set poolAddress(address: Address) {
    this._poolAddress = address.toLowerCase();
  }

  async initialize(
    blockNumber: number,
    options?: InitializeStateOptions<PoolState>,
  ) {
    await super.initialize(blockNumber, options);
    // only if the super call succeed

    const initPromises = [];
    if (!this.token0sub.isInitialized && !this.dexHelper.config.isSlave) {
      initPromises.push(
        this.token0sub.initialize(blockNumber, {
          state: {},
        }),
      );
    }

    if (!this.token1sub.isInitialized && !this.dexHelper.config.isSlave) {
      initPromises.push(
        this.token1sub.initialize(blockNumber, {
          state: {},
        }),
      );
    }

    await Promise.all(initPromises);

    await Promise.all([
      this.token0sub.subscribeToWalletBalanceChange(
        this.poolAddress,
        blockNumber,
      ),
      this.token1sub.subscribeToWalletBalanceChange(
        this.poolAddress,
        blockNumber,
      ),
    ]);
  }

  protected async processBlockLogs(
    state: DeepReadonly<PoolState>,
    logs: Readonly<Log>[],
    blockHeader: Readonly<BlockHeader>,
  ): Promise<DeepReadonly<PoolState> | null> {
    const newState = await super.processBlockLogs(state, logs, blockHeader);
    if (newState && !newState.isValid) {
      return await this.generateState(blockHeader.number);
    }
    return newState;
  }

  protected processLog(
    state: DeepReadonly<PoolState>,
    log: Readonly<Log>,
    blockHeader: Readonly<BlockHeader>,
  ): DeepReadonly<PoolState> | null {
    try {
      const event = this.logDecoder(log);
      if (event.name in this.handlers) {
        // Because we have observations in array which is mutable by nature, there is a
        // ts compile error: https://stackoverflow.com/questions/53412934/disable-allowing-assigning-readonly-types-to-non-readonly-types
        // And there is no good workaround, so turn off the type checker for this line
        const _state = _.cloneDeep(state) as PoolState;
        try {
          return this.handlers[event.name](event, _state, log, blockHeader);
        } catch (e) {
          if (
            e instanceof Error &&
            e.message.endsWith(OUT_OF_RANGE_ERROR_POSTFIX)
          ) {
            this.logger.warn(
              `${this.parentName}: Pool ${this.poolAddress} on ${
                this.dexHelper.config.data.network
              } is out of TickBitmap requested range. Re-query the state. ${JSON.stringify(
                event,
              )}`,
              e,
            );
          } else {
            this.logger.error(
              `${this.parentName}: Pool ${this.poolAddress}, ` +
                `network=${this.dexHelper.config.data.network}: Unexpected ` +
                `error while handling event on blockNumber=${blockHeader.number}, ` +
                `blockHash=${blockHeader.hash} and parentHash=${
                  blockHeader.parentHash
                } for UniswapV3, ${JSON.stringify(event)}`,
              e,
            );
          }
          _state.isValid = false;
          return _state;
        }
      }
    } catch (e) {
      catchParseLogError(e, this.logger);
    }
    return null; // ignore unrecognized event
  }

  private _getStateRequestCallData() {
    if (!this._stateRequestCallData) {
      const callData = {
        funcName: 'getFullStateWithRelativeBitmaps',
        params: [
          this.factoryAddress,
          this.token0,
          this.token1,
          this.feeCode,
          this.getBitmapRangeToRequest(),
          this.getBitmapRangeToRequest(),
        ],
      };
      this._stateRequestCallData = callData;
    }
    return this._stateRequestCallData;
  }

  getBitmapRangeToRequest() {
    return TICK_BITMAP_TO_USE + TICK_BITMAP_BUFFER;
  }

  async generateState(blockNumber: number): Promise<Readonly<PoolState>> {
    const callData = this._getStateRequestCallData();

    const results = await this.stateMultiContract.methods[callData.funcName](
      ...callData.params,
    ).call({}, blockNumber || 'latest');

    const _state = results;

    const tickBitmap = {};
    const ticks = {};

    this._reduceTickBitmap(tickBitmap, _state.tickBitmap);
    this._reduceTicks(ticks, _state.ticks);

    const observations = {
      [_state.slot0.observationIndex]: {
        blockTimestamp: bigIntify(_state.observation.blockTimestamp),
        tickCumulative: bigIntify(_state.observation.tickCumulative),
        secondsPerLiquidityCumulativeX128: bigIntify(
          _state.observation.secondsPerLiquidityCumulativeX128,
        ),
        initialized: _state.observation.initialized,
      },
    };

    const currentTick = bigIntify(_state.slot0.tick);
    const tickSpacing = bigIntify(_state.tickSpacing);

    const startTickBitmap = TickBitMap.position(currentTick / tickSpacing)[0];
    const requestedRange = this.getBitmapRangeToRequest();

    return {
      pool: _state.pool,
      blockTimestamp: bigIntify(_state.blockTimestamp),
      slot0: {
        sqrtPriceX96: bigIntify(_state.slot0.sqrtPriceX96),
        tick: currentTick,
        observationIndex: +_state.slot0.observationIndex,
        observationCardinality: +_state.slot0.observationCardinality,
        observationCardinalityNext: +_state.slot0.observationCardinalityNext,
        feeProtocol: bigIntify(_state.slot0.feeProtocol),
      },
      liquidity: bigIntify(_state.liquidity),
      fee: this.feeCode,
      tickSpacing,
      maxLiquidityPerTick: bigIntify(_state.maxLiquidityPerTick),
      tickBitmap,
      ticks,
      observations,
      isValid: true,
      startTickBitmap,
      lowestKnownTick:
        (BigInt.asIntN(24, startTickBitmap - requestedRange) << 8n) *
        tickSpacing,
      highestKnownTick:
        ((BigInt.asIntN(24, startTickBitmap + requestedRange) << 8n) +
          BigInt.asIntN(24, 255n)) *
        tickSpacing,
    };
  }

  handleSwapEvent(
    event: any,
    pool: PoolState,
    log: Log,
    blockHeader: BlockHeader,
  ) {
    const newSqrtPriceX96 = bigIntify(event.args.sqrtPriceX96);
    const amount0 = bigIntify(event.args.amount0);
    const amount1 = bigIntify(event.args.amount1);
    const newTick = bigIntify(event.args.tick);
    const newLiquidity = bigIntify(event.args.liquidity);
    pool.blockTimestamp = bigIntify(blockHeader.timestamp);

    if (amount0 <= 0n && amount1 <= 0n) {
      this.logger.error(
        `${this.parentName}: amount0 <= 0n && amount1 <= 0n for ` +
          `${this.poolAddress} and ${blockHeader.number}. Check why it happened`,
      );
      pool.isValid = false;
      return pool;
    } else {
      const zeroForOne = amount0 > 0n;

      uniswapV3Math.swapFromEvent(
        pool,
        newSqrtPriceX96,
        newTick,
        newLiquidity,
        zeroForOne,
      );

      return pool;
    }
  }

  handleBurnEvent(
    event: any,
    pool: PoolState,
    log: Log,
    blockHeader: BlockHeader,
  ) {
    const amount = bigIntify(event.args.amount);
    const tickLower = bigIntify(event.args.tickLower);
    const tickUpper = bigIntify(event.args.tickUpper);
    pool.blockTimestamp = bigIntify(blockHeader.timestamp);

    uniswapV3Math._modifyPosition(pool, {
      tickLower,
      tickUpper,
      liquidityDelta: -BigInt.asIntN(128, BigInt.asIntN(256, amount)),
    });

    return pool;
  }

  handleMintEvent(
    event: any,
    pool: PoolState,
    log: Log,
    blockHeader: BlockHeader,
  ) {
    const amount = bigIntify(event.args.amount);
    const tickLower = bigIntify(event.args.tickLower);
    const tickUpper = bigIntify(event.args.tickUpper);
    pool.blockTimestamp = bigIntify(blockHeader.timestamp);

    uniswapV3Math._modifyPosition(pool, {
      tickLower,
      tickUpper,
      liquidityDelta: amount,
    });

    return pool;
  }

  handleSetFeeProtocolEvent(
    event: any,
    pool: PoolState,
    log: Log,
    blockHeader: BlockHeader,
  ) {
    const feeProtocol0 = bigIntify(event.args.feeProtocol0New);
    const feeProtocol1 = bigIntify(event.args.feeProtocol1New);
    pool.slot0.feeProtocol = feeProtocol0 + (feeProtocol1 << 4n);
    pool.blockTimestamp = bigIntify(blockHeader.timestamp);

    return pool;
  }

  handleIncreaseObservationCardinalityNextEvent(
    event: any,
    pool: PoolState,
    log: Log,
    blockHeader: BlockHeader,
  ) {
    pool.slot0.observationCardinalityNext = parseInt(
      event.args.observationCardinalityNextNew,
      10,
    );
    pool.blockTimestamp = bigIntify(blockHeader.timestamp);
    return pool;
  }

  private _reduceTickBitmap(
    tickBitmap: Record<NumberAsString, bigint>,
    tickBitmapToReduce: TickBitMapMappings[],
  ) {
    return tickBitmapToReduce.reduce<Record<NumberAsString, bigint>>(
      (acc, curr) => {
        const { index, value } = curr;
        acc[index] = bigIntify(value);
        return acc;
      },
      tickBitmap,
    );
  }

  private _reduceTicks(
    ticks: Record<NumberAsString, TickInfo>,
    ticksToReduce: TickInfoMappings[],
  ) {
    return ticksToReduce.reduce<Record<string, TickInfo>>((acc, curr) => {
      const { index, value } = curr;
      acc[index] = {
        liquidityGross: bigIntify(value.liquidityGross),
        liquidityNet: bigIntify(value.liquidityNet),
        tickCumulativeOutside: bigIntify(value.tickCumulativeOutside),
        secondsPerLiquidityOutsideX128: bigIntify(
          value.secondsPerLiquidityOutsideX128,
        ),
        secondsOutside: bigIntify(value.secondsOutside),
        initialized: value.initialized,
      };
      return acc;
    }, ticks);
  }

  public getBalanceToken0(blockNumber: number) {
    return this.token0sub.getBalance(this.poolAddress, blockNumber);
  }

  public getBalanceToken1(blockNumber: number) {
    return this.token1sub.getBalance(this.poolAddress, blockNumber);
  }
}

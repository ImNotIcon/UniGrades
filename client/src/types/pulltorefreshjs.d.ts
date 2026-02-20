declare module 'pulltorefreshjs' {
  export interface PullToRefreshInstance {
    destroy(): void;
  }

  export interface PullToRefreshOptions {
    distThreshold?: number;
    distMax?: number;
    distReload?: number;
    distIgnore?: number;
    mainElement?: string;
    triggerElement?: string;
    ptrElement?: string;
    classPrefix?: string;
    cssProp?: string;
    iconArrow?: string;
    iconRefreshing?: string;
    instructionsPullToRefresh?: string;
    instructionsReleaseToRefresh?: string;
    instructionsRefreshing?: string;
    refreshTimeout?: number;
    getMarkup?(): string;
    getStyles?(): string;
    onInit?(): void;
    onRefresh?(): PromiseLike<void> | void;
    resistanceFunction?(input: number): number;
    shouldPullToRefresh?(): boolean;
  }

  const PullToRefresh: {
    init(options?: PullToRefreshOptions): PullToRefreshInstance;
    destroyAll(): void;
    setPassiveMode(isPassive: boolean): void;
    setPointerEventsMode(isEnabled: boolean): void;
  };

  export default PullToRefresh;
}

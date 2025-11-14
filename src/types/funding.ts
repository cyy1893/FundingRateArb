export type FundingHistoryPoint = {
  time: number;
  hyperliquid: number | null;
  binance: number | null;
  arbitrage: number | null;
};

export type LiveFundingResponse = {
  hyperliquid: Record<string, number>;
  binance: Record<string, number>;
};

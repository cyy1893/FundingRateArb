export type MarketRow = {
  symbol: string;
  displayName: string;
  iconUrl: string | null;
  coingeckoId: string | null;
  markPrice: number;
  priceChange1h: number | null;
  priceChange24h: number | null;
  priceChange7d: number | null;
  maxLeverage: number;
  fundingRate: number;
  dayNotionalVolume: number | null;
  openInterest: number;
  volumeUsd: number | null;
  binance: {
    symbol: string;
    maxLeverage: number | null;
    fundingRate: number | null;
    volumeUsd: number | null;
    fundingPeriodHours: number | null;
  } | null;
};

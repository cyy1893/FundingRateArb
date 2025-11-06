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
  dayNotionalVolume: number;
  openInterest: number;
  spotVolumeUsd: number | null;
  binance?: {
    symbol: string;
    maxLeverage: number | null;
    fundingRate: number | null;
  } | null;
};

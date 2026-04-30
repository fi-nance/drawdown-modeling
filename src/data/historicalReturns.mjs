export const HISTORICAL_RETURN_DATA_VERSION = "2026.1";

export const HISTORICAL_RETURN_SOURCES = [
  {
    name: "NYU Stern Damodaran historical returns",
    url: "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html",
    covers: "S&P 500, 10-year Treasuries, 3-month T-bills, real estate, through 2025"
  },
  {
    name: "NYU Stern Damodaran historical inflation",
    url: "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histret.html",
    covers: "Inflation through 2023"
  },
  {
    name: "FRED CPIAUCSL",
    url: "https://fred.stlouisfed.org/series/CPIAUCSL",
    covers: "CPI-based inflation extension for 2024 and 2025"
  },
  {
    name: "iShares TIPS Bond ETF performance",
    url: "https://www.ishares.com/ch/professionals/en/products/239467/ishares-tips-bond-etf",
    covers: "TIPS ETF total return history where available"
  },
  {
    name: "Coin Metrics community BTC PriceUSD",
    url: "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics",
    covers: "Bitcoin daily USD prices through 2025"
  }
];

export const HISTORICAL_ASSET_CLASSES = ["stock", "bond", "cash", "realEstate", "tips", "crypto"];

export const HISTORICAL_RETURNS = [
  {
    year: 1928,
    stock: 0.4381,
    bond: 0.0084,
    cash: 0.0308,
    realEstate: 0.0149,
    tips: null,
    crypto: null,
    inflation: -0.0116
  },
  {
    year: 1929,
    stock: -0.083,
    bond: 0.042,
    cash: 0.0316,
    realEstate: -0.0206,
    tips: null,
    crypto: null,
    inflation: 0.0058
  },
  {
    year: 1930,
    stock: -0.2512,
    bond: 0.0454,
    cash: 0.0455,
    realEstate: -0.043,
    tips: null,
    crypto: null,
    inflation: -0.064
  },
  {
    year: 1931,
    stock: -0.4384,
    bond: -0.0256,
    cash: 0.0231,
    realEstate: -0.0815,
    tips: null,
    crypto: null,
    inflation: -0.0932
  },
  {
    year: 1932,
    stock: -0.0864,
    bond: 0.0879,
    cash: 0.0107,
    realEstate: -0.1047,
    tips: null,
    crypto: null,
    inflation: -0.1027
  },
  {
    year: 1933,
    stock: 0.4998,
    bond: 0.0186,
    cash: 0.0096,
    realEstate: -0.0381,
    tips: null,
    crypto: null,
    inflation: 0.0076
  },
  {
    year: 1934,
    stock: -0.0119,
    bond: 0.0796,
    cash: 0.0028,
    realEstate: 0.0291,
    tips: null,
    crypto: null,
    inflation: 0.0152
  },
  {
    year: 1935,
    stock: 0.4674,
    bond: 0.0447,
    cash: 0.0017,
    realEstate: 0.0977,
    tips: null,
    crypto: null,
    inflation: 0.0299
  },
  {
    year: 1936,
    stock: 0.3194,
    bond: 0.0502,
    cash: 0.0017,
    realEstate: 0.0322,
    tips: null,
    crypto: null,
    inflation: 0.0145
  },
  {
    year: 1937,
    stock: -0.3534,
    bond: 0.0138,
    cash: 0.0028,
    realEstate: 0.0256,
    tips: null,
    crypto: null,
    inflation: 0.0286
  },
  {
    year: 1938,
    stock: 0.2928,
    bond: 0.0421,
    cash: 0.0007,
    realEstate: -0.0087,
    tips: null,
    crypto: null,
    inflation: -0.0278
  },
  {
    year: 1939,
    stock: -0.011,
    bond: 0.0441,
    cash: 0.0005,
    realEstate: -0.013,
    tips: null,
    crypto: null,
    inflation: 0
  },
  {
    year: 1940,
    stock: -0.1067,
    bond: 0.054,
    cash: 0.0004,
    realEstate: 0.0331,
    tips: null,
    crypto: null,
    inflation: 0.0071
  },
  {
    year: 1941,
    stock: -0.1277,
    bond: -0.0202,
    cash: 0.0013,
    realEstate: -0.0838,
    tips: null,
    crypto: null,
    inflation: 0.0993
  },
  {
    year: 1942,
    stock: 0.1917,
    bond: 0.0229,
    cash: 0.0034,
    realEstate: 0.0333,
    tips: null,
    crypto: null,
    inflation: 0.0903
  },
  {
    year: 1943,
    stock: 0.2506,
    bond: 0.0249,
    cash: 0.0038,
    realEstate: 0.1145,
    tips: null,
    crypto: null,
    inflation: 0.0296
  },
  {
    year: 1944,
    stock: 0.1903,
    bond: 0.0258,
    cash: 0.0038,
    realEstate: 0.1658,
    tips: null,
    crypto: null,
    inflation: 0.023
  },
  {
    year: 1945,
    stock: 0.3582,
    bond: 0.038,
    cash: 0.0038,
    realEstate: 0.1178,
    tips: null,
    crypto: null,
    inflation: 0.0225
  },
  {
    year: 1946,
    stock: -0.0843,
    bond: 0.0313,
    cash: 0.0038,
    realEstate: 0.241,
    tips: null,
    crypto: null,
    inflation: 0.1813
  },
  {
    year: 1947,
    stock: 0.052,
    bond: 0.0092,
    cash: 0.006,
    realEstate: 0.2126,
    tips: null,
    crypto: null,
    inflation: 0.0884
  },
  {
    year: 1948,
    stock: 0.057,
    bond: 0.0195,
    cash: 0.0105,
    realEstate: 0.0206,
    tips: null,
    crypto: null,
    inflation: 0.0273
  },
  {
    year: 1949,
    stock: 0.183,
    bond: 0.0466,
    cash: 0.0112,
    realEstate: 0.0009,
    tips: null,
    crypto: null,
    inflation: -0.0183
  },
  {
    year: 1950,
    stock: 0.3081,
    bond: 0.0043,
    cash: 0.012,
    realEstate: 0.0364,
    tips: null,
    crypto: null,
    inflation: 0.058
  },
  {
    year: 1951,
    stock: 0.2368,
    bond: -0.003,
    cash: 0.0152,
    realEstate: 0.0605,
    tips: null,
    crypto: null,
    inflation: 0.0596
  },
  {
    year: 1952,
    stock: 0.1815,
    bond: 0.0227,
    cash: 0.0172,
    realEstate: 0.0441,
    tips: null,
    crypto: null,
    inflation: 0.0091
  },
  {
    year: 1953,
    stock: -0.0121,
    bond: 0.0414,
    cash: 0.0189,
    realEstate: 0.1152,
    tips: null,
    crypto: null,
    inflation: 0.006
  },
  {
    year: 1954,
    stock: 0.5256,
    bond: 0.0329,
    cash: 0.0094,
    realEstate: 0.0092,
    tips: null,
    crypto: null,
    inflation: -0.0037
  },
  {
    year: 1955,
    stock: 0.326,
    bond: -0.0134,
    cash: 0.0172,
    realEstate: 0,
    tips: null,
    crypto: null,
    inflation: 0.0037
  },
  {
    year: 1956,
    stock: 0.0744,
    bond: -0.0226,
    cash: 0.0262,
    realEstate: 0.0091,
    tips: null,
    crypto: null,
    inflation: 0.0283
  },
  {
    year: 1957,
    stock: -0.1046,
    bond: 0.068,
    cash: 0.0322,
    realEstate: 0.0272,
    tips: null,
    crypto: null,
    inflation: 0.0304
  },
  {
    year: 1958,
    stock: 0.4372,
    bond: -0.021,
    cash: 0.0177,
    realEstate: 0.0066,
    tips: null,
    crypto: null,
    inflation: 0.0176
  },
  {
    year: 1959,
    stock: 0.1206,
    bond: -0.0265,
    cash: 0.0339,
    realEstate: 0.0011,
    tips: null,
    crypto: null,
    inflation: 0.0152
  },
  {
    year: 1960,
    stock: 0.0034,
    bond: 0.1164,
    cash: 0.0287,
    realEstate: 0.0077,
    tips: null,
    crypto: null,
    inflation: 0.0136
  },
  {
    year: 1961,
    stock: 0.2664,
    bond: 0.0206,
    cash: 0.0235,
    realEstate: 0.0098,
    tips: null,
    crypto: null,
    inflation: 0.0067
  },
  {
    year: 1962,
    stock: -0.0881,
    bond: 0.0569,
    cash: 0.0277,
    realEstate: 0.0032,
    tips: null,
    crypto: null,
    inflation: 0.0123
  },
  {
    year: 1963,
    stock: 0.2261,
    bond: 0.0168,
    cash: 0.0316,
    realEstate: 0.0214,
    tips: null,
    crypto: null,
    inflation: 0.0165
  },
  {
    year: 1964,
    stock: 0.1642,
    bond: 0.0373,
    cash: 0.0355,
    realEstate: 0.0126,
    tips: null,
    crypto: null,
    inflation: 0.012
  },
  {
    year: 1965,
    stock: 0.124,
    bond: 0.0072,
    cash: 0.0395,
    realEstate: 0.0166,
    tips: null,
    crypto: null,
    inflation: 0.0192
  },
  {
    year: 1966,
    stock: -0.0997,
    bond: 0.0291,
    cash: 0.0486,
    realEstate: 0.0122,
    tips: null,
    crypto: null,
    inflation: 0.0336
  },
  {
    year: 1967,
    stock: 0.238,
    bond: -0.0158,
    cash: 0.0429,
    realEstate: 0.0232,
    tips: null,
    crypto: null,
    inflation: 0.0328
  },
  {
    year: 1968,
    stock: 0.1081,
    bond: 0.0327,
    cash: 0.0534,
    realEstate: 0.0413,
    tips: null,
    crypto: null,
    inflation: 0.0471
  },
  {
    year: 1969,
    stock: -0.0824,
    bond: -0.0501,
    cash: 0.0667,
    realEstate: 0.0699,
    tips: null,
    crypto: null,
    inflation: 0.059
  },
  {
    year: 1970,
    stock: 0.0356,
    bond: 0.1675,
    cash: 0.0639,
    realEstate: 0.0822,
    tips: null,
    crypto: null,
    inflation: 0.0557
  },
  {
    year: 1971,
    stock: 0.1422,
    bond: 0.0979,
    cash: 0.0433,
    realEstate: 0.0424,
    tips: null,
    crypto: null,
    inflation: 0.0327
  },
  {
    year: 1972,
    stock: 0.1876,
    bond: 0.0282,
    cash: 0.0406,
    realEstate: 0.0298,
    tips: null,
    crypto: null,
    inflation: 0.0341
  },
  {
    year: 1973,
    stock: -0.1431,
    bond: 0.0366,
    cash: 0.0704,
    realEstate: 0.0342,
    tips: null,
    crypto: null,
    inflation: 0.0894
  },
  {
    year: 1974,
    stock: -0.259,
    bond: 0.0199,
    cash: 0.0785,
    realEstate: 0.1007,
    tips: null,
    crypto: null,
    inflation: 0.121
  },
  {
    year: 1975,
    stock: 0.37,
    bond: 0.0361,
    cash: 0.0579,
    realEstate: 0.0677,
    tips: null,
    crypto: null,
    inflation: 0.0713
  },
  {
    year: 1976,
    stock: 0.2383,
    bond: 0.1598,
    cash: 0.0498,
    realEstate: 0.0818,
    tips: null,
    crypto: null,
    inflation: 0.0504
  },
  {
    year: 1977,
    stock: -0.0698,
    bond: 0.0129,
    cash: 0.0526,
    realEstate: 0.1465,
    tips: null,
    crypto: null,
    inflation: 0.0668
  },
  {
    year: 1978,
    stock: 0.0651,
    bond: -0.0078,
    cash: 0.0718,
    realEstate: 0.1572,
    tips: null,
    crypto: null,
    inflation: 0.0899
  },
  {
    year: 1979,
    stock: 0.1852,
    bond: 0.0067,
    cash: 0.1005,
    realEstate: 0.1374,
    tips: null,
    crypto: null,
    inflation: 0.1325
  },
  {
    year: 1980,
    stock: 0.3174,
    bond: -0.0299,
    cash: 0.1139,
    realEstate: 0.074,
    tips: null,
    crypto: null,
    inflation: 0.1235
  },
  {
    year: 1981,
    stock: -0.047,
    bond: 0.082,
    cash: 0.1404,
    realEstate: 0.051,
    tips: null,
    crypto: null,
    inflation: 0.0891
  },
  {
    year: 1982,
    stock: 0.2042,
    bond: 0.3281,
    cash: 0.1109,
    realEstate: 0.0056,
    tips: null,
    crypto: null,
    inflation: 0.0383
  },
  {
    year: 1983,
    stock: 0.2234,
    bond: 0.032,
    cash: 0.0895,
    realEstate: 0.0475,
    tips: null,
    crypto: null,
    inflation: 0.0379
  },
  {
    year: 1984,
    stock: 0.0615,
    bond: 0.1373,
    cash: 0.0992,
    realEstate: 0.0468,
    tips: null,
    crypto: null,
    inflation: 0.0404
  },
  {
    year: 1985,
    stock: 0.3124,
    bond: 0.2571,
    cash: 0.0772,
    realEstate: 0.0747,
    tips: null,
    crypto: null,
    inflation: 0.0379
  },
  {
    year: 1986,
    stock: 0.1849,
    bond: 0.2428,
    cash: 0.0615,
    realEstate: 0.0961,
    tips: null,
    crypto: null,
    inflation: 0.0119
  },
  {
    year: 1987,
    stock: 0.0581,
    bond: -0.0496,
    cash: 0.0596,
    realEstate: 0.0785,
    tips: null,
    crypto: null,
    inflation: 0.0433
  },
  {
    year: 1988,
    stock: 0.1654,
    bond: 0.0822,
    cash: 0.0689,
    realEstate: 0.0722,
    tips: null,
    crypto: null,
    inflation: 0.0441
  },
  {
    year: 1989,
    stock: 0.3148,
    bond: 0.1769,
    cash: 0.0839,
    realEstate: 0.0439,
    tips: null,
    crypto: null,
    inflation: 0.0464
  },
  {
    year: 1990,
    stock: -0.0306,
    bond: 0.0624,
    cash: 0.0775,
    realEstate: -0.0069,
    tips: null,
    crypto: null,
    inflation: 0.0625
  },
  {
    year: 1991,
    stock: 0.3023,
    bond: 0.15,
    cash: 0.0554,
    realEstate: -0.0017,
    tips: null,
    crypto: null,
    inflation: 0.0298
  },
  {
    year: 1992,
    stock: 0.0749,
    bond: 0.0936,
    cash: 0.0351,
    realEstate: 0.0082,
    tips: null,
    crypto: null,
    inflation: 0.0297
  },
  {
    year: 1993,
    stock: 0.0997,
    bond: 0.1421,
    cash: 0.0307,
    realEstate: 0.0216,
    tips: null,
    crypto: null,
    inflation: 0.0281
  },
  {
    year: 1994,
    stock: 0.0133,
    bond: -0.0804,
    cash: 0.0437,
    realEstate: 0.0252,
    tips: null,
    crypto: null,
    inflation: 0.026
  },
  {
    year: 1995,
    stock: 0.372,
    bond: 0.2348,
    cash: 0.0566,
    realEstate: 0.0179,
    tips: null,
    crypto: null,
    inflation: 0.0253
  },
  {
    year: 1996,
    stock: 0.2268,
    bond: 0.0143,
    cash: 0.0515,
    realEstate: 0.0243,
    tips: null,
    crypto: null,
    inflation: 0.0338
  },
  {
    year: 1997,
    stock: 0.331,
    bond: 0.0994,
    cash: 0.052,
    realEstate: 0.0402,
    tips: null,
    crypto: null,
    inflation: 0.017
  },
  {
    year: 1998,
    stock: 0.2834,
    bond: 0.1492,
    cash: 0.0491,
    realEstate: 0.0644,
    tips: null,
    crypto: null,
    inflation: 0.0161
  },
  {
    year: 1999,
    stock: 0.2089,
    bond: -0.0825,
    cash: 0.0478,
    realEstate: 0.0768,
    tips: null,
    crypto: null,
    inflation: 0.0268
  },
  {
    year: 2000,
    stock: -0.0903,
    bond: 0.1666,
    cash: 0.06,
    realEstate: 0.0929,
    tips: null,
    crypto: null,
    inflation: 0.0344
  },
  {
    year: 2001,
    stock: -0.1185,
    bond: 0.0557,
    cash: 0.0348,
    realEstate: 0.0668,
    tips: null,
    crypto: null,
    inflation: 0.016
  },
  {
    year: 2002,
    stock: -0.2197,
    bond: 0.1512,
    cash: 0.0164,
    realEstate: 0.0956,
    tips: null,
    crypto: null,
    inflation: 0.0248
  },
  {
    year: 2003,
    stock: 0.2836,
    bond: 0.0038,
    cash: 0.0103,
    realEstate: 0.0981,
    tips: null,
    crypto: null,
    inflation: 0.0204
  },
  {
    year: 2004,
    stock: 0.1074,
    bond: 0.0449,
    cash: 0.014,
    realEstate: 0.1364,
    tips: 0.082128,
    crypto: null,
    inflation: 0.0334
  },
  {
    year: 2005,
    stock: 0.0483,
    bond: 0.0287,
    cash: 0.0322,
    realEstate: 0.1351,
    tips: 0.026475,
    crypto: null,
    inflation: 0.0334
  },
  {
    year: 2006,
    stock: 0.1561,
    bond: 0.0196,
    cash: 0.0485,
    realEstate: 0.0173,
    tips: 0.002922,
    crypto: null,
    inflation: 0.0252
  },
  {
    year: 2007,
    stock: 0.0548,
    bond: 0.1021,
    cash: 0.0448,
    realEstate: -0.054,
    tips: 0.114583,
    crypto: null,
    inflation: 0.0064
  },
  {
    year: 2008,
    stock: -0.3655,
    bond: 0.201,
    cash: 0.014,
    realEstate: -0.12,
    tips: -0.025193,
    crypto: null,
    inflation: -0.0002
  },
  {
    year: 2009,
    stock: 0.2594,
    bond: -0.1112,
    cash: 0.0015,
    realEstate: -0.0385,
    tips: 0.113834,
    crypto: null,
    inflation: 0.0281
  },
  {
    year: 2010,
    stock: 0.1482,
    bond: 0.0846,
    cash: 0.0014,
    realEstate: -0.0412,
    tips: 0.060952,
    crypto: null,
    inflation: 0.0144
  },
  {
    year: 2011,
    stock: 0.021,
    bond: 0.1604,
    cash: 0.0005,
    realEstate: -0.0389,
    tips: 0.133994,
    crypto: 14.714354,
    inflation: 0.0306
  },
  {
    year: 2012,
    stock: 0.1589,
    bond: 0.0297,
    cash: 0.0009,
    realEstate: 0.0644,
    tips: 0.067965,
    crypto: 1.873286,
    inflation: 0.0176
  },
  {
    year: 2013,
    stock: 0.3215,
    bond: -0.091,
    cash: 0.0006,
    realEstate: 0.1072,
    tips: -0.086557,
    crypto: 52.859567,
    inflation: 0.0151
  },
  {
    year: 2014,
    stock: 0.1352,
    bond: 0.1075,
    cash: 0.0003,
    realEstate: 0.045,
    tips: 0.034988,
    crypto: -0.56047,
    inflation: 0.0065
  },
  {
    year: 2015,
    stock: 0.0138,
    bond: 0.0128,
    cash: 0.0005,
    realEstate: 0.0519,
    tips: -0.015937,
    crypto: 0.339968,
    inflation: 0.0064
  },
  {
    year: 2016,
    stock: 0.1177,
    bond: 0.0069,
    cash: 0.0032,
    realEstate: 0.0531,
    tips: 0.045644,
    crypto: 1.255113,
    inflation: 0.0205
  },
  {
    year: 2017,
    stock: 0.2161,
    bond: 0.028,
    cash: 0.0095,
    realEstate: 0.0621,
    tips: 0.029185,
    crypto: 13.367289,
    inflation: 0.0213
  },
  {
    year: 2018,
    stock: -0.0423,
    bond: -0.0002,
    cash: 0.0197,
    realEstate: 0.0452,
    tips: -0.014284,
    crypto: -0.735143,
    inflation: 0.02
  },
  {
    year: 2019,
    stock: 0.3121,
    bond: 0.0964,
    cash: 0.0211,
    realEstate: 0.0369,
    tips: 0.082721,
    crypto: 0.943859,
    inflation: 0.0231
  },
  {
    year: 2020,
    stock: 0.1802,
    bond: 0.1133,
    cash: 0.0036,
    realEstate: 0.1043,
    tips: 0.109085,
    crypto: 3.049264,
    inflation: 0.0132
  },
  {
    year: 2021,
    stock: 0.2847,
    bond: -0.0442,
    cash: 0.0004,
    realEstate: 0.1886,
    tips: 0.055218,
    crypto: 0.597204,
    inflation: 0.0719
  },
  {
    year: 2022,
    stock: -0.1804,
    bond: -0.1783,
    cash: 0.0209,
    realEstate: 0.0565,
    tips: -0.12129,
    crypto: -0.64353,
    inflation: 0.0644
  },
  {
    year: 2023,
    stock: 0.2606,
    bond: 0.0388,
    cash: 0.0528,
    realEstate: 0.0568,
    tips: 0.036788,
    crypto: 1.554866,
    inflation: 0.0312
  },
  {
    year: 2024,
    stock: 0.2488,
    bond: -0.0164,
    cash: 0.0518,
    realEstate: 0.0396,
    tips: 0.018854,
    crypto: 1.212127,
    inflation: 0.028707
  },
  {
    year: 2025,
    stock: 0.1778,
    bond: 0.078,
    cash: 0.0421,
    realEstate: 0.0158,
    tips: 0.067074,
    crypto: -0.062884,
    inflation: 0.026533
  }
];

export function makeHistoricalSequences({
  planYears = 35,
  mode = "all",
  startYear = 1928,
  endYear = 2025,
  chunkYears = 10,
  requiredAssetClasses = []
} = {}) {
  const years = Math.max(1, Math.trunc(Number(planYears) || 1));
  const start = clampYear(startYear, HISTORICAL_RETURNS[0].year, HISTORICAL_RETURNS.at(-1).year);
  const end = clampYear(endYear, start, HISTORICAL_RETURNS.at(-1).year);
  const required = normalizeRequiredClasses(requiredAssetClasses);
  const rows = HISTORICAL_RETURNS
    .filter((row) => row.year >= start && row.year <= end && supportsAssetClasses(row, required));

  if (!rows.length) return [];
  if (mode === "specific") return specificSequence(rows, years, start);
  if (mode === "chunks") return chunkedSequences(rows, years, chunkYears);
  return rollingSequences(rows, years);
}

export function historicalCoverageForAssetClasses(requiredAssetClasses = []) {
  const required = normalizeRequiredClasses(requiredAssetClasses);
  const rows = HISTORICAL_RETURNS.filter((row) => supportsAssetClasses(row, required));
  if (!rows.length) return null;
  return {
    startYear: rows[0].year,
    endYear: rows.at(-1).year,
    rowCount: rows.length,
    dataVersion: HISTORICAL_RETURN_DATA_VERSION
  };
}

export function assetClassesInPortfolio(assets = []) {
  return [...new Set(assets.map((asset) => asset.assetClass).filter((assetClass) => HISTORICAL_ASSET_CLASSES.includes(assetClass)))];
}

function rollingSequences(rows, planYears) {
  if (rows.length <= planYears) return [sequenceFromRows(repeatRowsToLength(rows, planYears), labelForRows(rows, rows.length < planYears))];
  const sequences = [];
  for (let index = 0; index <= rows.length - planYears; index += 1) {
    const windowRows = rows.slice(index, index + planYears);
    sequences.push(sequenceFromRows(windowRows, labelForRows(windowRows)));
  }
  return sequences;
}

function specificSequence(rows, planYears, requestedStartYear) {
  if (rows.length <= planYears) return [sequenceFromRows(repeatRowsToLength(rows, planYears), labelForRows(rows, true))];
  const requestedIndex = rows.findIndex((row) => row.year >= requestedStartYear);
  const boundedIndex = Math.min(Math.max(0, requestedIndex), rows.length - planYears);
  const windowRows = rows.slice(boundedIndex, boundedIndex + planYears);
  return [sequenceFromRows(windowRows, labelForRows(windowRows))];
}

function chunkedSequences(rows, planYears, chunkYears) {
  const size = Math.max(1, Math.trunc(Number(chunkYears) || 10));
  const sequences = [];
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size);
    if (!chunk.length) continue;
    if (chunk.length >= planYears) {
      sequences.push(...rollingSequences(chunk, planYears));
    } else {
      sequences.push(sequenceFromRows(repeatRowsToLength(chunk, planYears), labelForRows(chunk, true)));
    }
  }
  return sequences;
}

function sequenceFromRows(rows, name) {
  return {
    name,
    sourceYears: rows.map((row) => row.year),
    startYear: rows[0]?.year ?? null,
    endYear: rows.at(-1)?.year ?? null,
    returns: rows.map(returnObjectForRow),
    inflation: rows.map((row) => row.inflation)
  };
}

function returnObjectForRow(row) {
  const result = { default: row.stock };
  for (const assetClass of HISTORICAL_ASSET_CLASSES) {
    if (Number.isFinite(row[assetClass])) result[assetClass] = row[assetClass];
  }
  return result;
}

function repeatRowsToLength(rows, length) {
  return Array.from({ length }, (_, index) => rows[index % rows.length]);
}

function labelForRows(rows, repeated = false) {
  const start = rows[0]?.year ?? "n/a";
  const end = rows.at(-1)?.year ?? "n/a";
  return repeated ? start + "-" + end + " repeated" : start + "-" + end;
}

function supportsAssetClasses(row, requiredAssetClasses) {
  return requiredAssetClasses.every((assetClass) => Number.isFinite(row[assetClass]));
}

function normalizeRequiredClasses(assetClasses) {
  return [...new Set(assetClasses)].filter((assetClass) => HISTORICAL_ASSET_CLASSES.includes(assetClass));
}

function clampYear(value, min, max) {
  const year = Math.trunc(Number(value) || min);
  return Math.max(min, Math.min(max, year));
}

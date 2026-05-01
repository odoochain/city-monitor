import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCache } from '../lib/cache.js';
import { createWeatherIngestion, type WeatherData } from './ingest-weather.js';

const mockOpenMeteoResponse = {
  current: {
    temperature_2m: 12.5,
    relative_humidity_2m: 65,
    apparent_temperature: 10.2,
    precipitation: 0,
    weather_code: 3,
    wind_speed_10m: 15.3,
    wind_direction_10m: 240,
    uv_index: 3.2,
    uv_index_clear_sky: 5.1,
  },
  hourly: {
    time: ['2026-03-02T00:00', '2026-03-02T01:00', '2026-03-02T02:00'],
    temperature_2m: [10, 9.5, 9],
    precipitation_probability: [20, 30, 10],
    weather_code: [3, 3, 2],
    uv_index: [0, 0.5, 1.2],
  },
  daily: {
    time: ['2026-03-02', '2026-03-03'],
    weather_code: [3, 61],
    temperature_2m_max: [15, 12],
    temperature_2m_min: [5, 4],
    precipitation_sum: [0, 5.2],
    sunrise: ['2026-03-02T06:30', '2026-03-03T06:28'],
    sunset: ['2026-03-02T18:15', '2026-03-03T18:17'],
    uv_index_max: [4.5, 2.1],
    uv_index_clear_sky_max: [6.0, 3.5],
  },
};

describe('ingest-weather', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('fetches weather from Open-Meteo and writes to cache', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockOpenMeteoResponse), { status: 200 }),
    );

    const cache = createCache();
    const ingest = createWeatherIngestion(cache);
    await ingest();

    const data = cache.get<WeatherData>('berlin:weather');
    expect(data).toBeTruthy();
    expect(data!.current.temp).toBe(12.5);
    expect(data!.current.humidity).toBe(65);
    expect(data!.current.weatherCode).toBe(3);
    expect(data!.hourly).toHaveLength(3);
    expect(data!.daily).toHaveLength(2);
  });

  it('transforms Open-Meteo response into clean API shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockOpenMeteoResponse), { status: 200 }),
    );

    const cache = createCache();
    const ingest = createWeatherIngestion(cache);
    await ingest();

    const data = cache.get<WeatherData>('berlin:weather')!;
    expect(data.current).toEqual({
      temp: 12.5,
      feelsLike: 10.2,
      humidity: 65,
      precipitation: 0,
      weatherCode: 3,
      windSpeed: 15.3,
      windDirection: 240,
      uvIndex: 3.2,
      uvIndexClearSky: 5.1,
    });

    expect(data.hourly[0]).toEqual({
      time: '2026-03-02T00:00',
      temp: 10,
      precipProb: 20,
      weatherCode: 3,
      uvIndex: 0,
    });

    expect(data.daily[0]).toEqual({
      date: '2026-03-02',
      high: 15,
      low: 5,
      weatherCode: 3,
      precip: 0,
      sunrise: '2026-03-02T06:30',
      sunset: '2026-03-02T18:15',
      uvIndexMax: 4.5,
      uvIndexClearSkyMax: 6.0,
    });
  });

  it('throws when Open-Meteo returns a non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('bad request', { status: 400 }),
    );

    const cache = createCache();
    const ingest = createWeatherIngestion(cache);

    await expect(ingest()).rejects.toThrow(/400/);
    expect(cache.get<WeatherData>('berlin:weather')).toBeNull();
  });

  describe('multi-city failure aggregation', () => {
    beforeEach(() => {
      vi.stubEnv('ACTIVE_CITIES', 'berlin,hamburg');
    });

    it('throws when any city fails, but successful cities still write to cache', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        // Berlin (52.52) fails on the Open-Meteo forecast call;
        // Hamburg (53.55) succeeds.
        if (url.includes('api.open-meteo.com/v1/forecast') && url.includes('latitude=52.52')) {
          return new Response('upstream error', { status: 502 });
        }
        return new Response(JSON.stringify(mockOpenMeteoResponse), { status: 200 });
      });

      const cache = createCache();
      const ingest = createWeatherIngestion(cache);

      await expect(ingest()).rejects.toThrow();

      // Hamburg should have completed despite Berlin failing
      expect(cache.get<WeatherData>('hamburg:weather')).toBeTruthy();
      // Berlin should not have written
      expect(cache.get<WeatherData>('berlin:weather')).toBeNull();
    });
  });
});

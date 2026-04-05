import type OpenAI from 'openai';

// Tool definitions for OpenAI API
export const toolDefinitions: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current date and time',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'IANA timezone, e.g. "Europe/Prague"',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          latitude: { type: 'number', description: 'Latitude' },
          longitude: { type: 'number', description: 'Longitude' },
          location_name: { type: 'string', description: 'Human-readable location name' },
        },
        required: ['latitude', 'longitude', 'location_name'],
      },
    },
  },
];

// Tool execution
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'get_current_time':
      return executeGetCurrentTime(args);
    case 'get_weather':
      return await executeGetWeather(args);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

function executeGetCurrentTime(args: Record<string, unknown>): string {
  const tz = (args.timezone as string) || 'Europe/Prague';
  const now = new Date();
  const formatted = now.toLocaleString('cs-CZ', { timeZone: tz });
  const dayName = now.toLocaleDateString('cs-CZ', { timeZone: tz, weekday: 'long' });
  return JSON.stringify({ timezone: tz, datetime: formatted, day: dayName });
}

async function executeGetWeather(args: Record<string, unknown>): Promise<string> {
  const { latitude, longitude, location_name } = args as {
    latitude: number;
    longitude: number;
    location_name: string;
  };

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=Europe/Prague`;

  const res = await fetch(url);
  if (!res.ok) {
    return JSON.stringify({ error: `Weather API error: ${res.status}` });
  }

  const data = await res.json();
  const current = data.current;

  return JSON.stringify({
    location: location_name,
    temperature_celsius: current.temperature_2m,
    humidity_percent: current.relative_humidity_2m,
    wind_speed_kmh: current.wind_speed_10m,
    weather_code: current.weather_code,
  });
}

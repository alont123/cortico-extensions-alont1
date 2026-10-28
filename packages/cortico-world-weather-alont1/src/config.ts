/** 天气 World 的配置。 */
export interface WeatherConfigSection {
  enabled: boolean
  /** 城市名，中文或英文；留空时按 IP 自动定位。 */
  city: string
}

export const WEATHER_DEFAULTS: WeatherConfigSection = {
  enabled: false,
  city: '',
}

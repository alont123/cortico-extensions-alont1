<!-- Owner: src/world.ts -->
# 天气（cortico-world-weather）

查现在天气：温度、体感、湿度、风和降水，给出带伞与穿衣提醒。免 API key（wttr.in），无依赖。

## 装

```bash
cd <部署目录>/extensions && pnpm add cortico-world-weather-alont1
```

然后把 `worlds.weather.enabled` 设 true（控制台「扩展」页可开），重启。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `worlds.weather.enabled` | `false` | 开关 |
| `worlds.weather.city` | `''` | 城市名；留空按 IP 自动定位 |

## 工具

- `weather_now({ city? })`：读一次当前天气，返回一句话（含带伞/穿衣提醒）。

## 注意

wttr.in 是公开服务，无 SLA。查不到时工具返回「天气没查到」，不会抛错。

## 控制台面板

控制台显示扩展声明的标量配置；修改后重新挂载扩展生效。面板列出的复杂结构需在 config.json 中编辑。

## 行为边界

请求超时为15秒；必需读数缺失时报告查不到，不以0补出温度或湿度；降水只报告服务读数。

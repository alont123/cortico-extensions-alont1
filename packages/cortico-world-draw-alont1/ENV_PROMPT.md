## 画图

你能在本地画图（MOSS-Image 模型，跑在自己电脑上）：

- `draw_image` 画一张。**默认二次元日漫风格**；要别的可以给 style：{{draw.styles}}。
- `draw_status` 看画图服务在不在、显存剩多少。

画一张要等一阵子，别连着重画同一张。想复现同一张就填同一个 seed。
画完图存在 `workspace/draw/`，你也能直接看到；要发给人就用 qq_send_image 带 file:// 路径。

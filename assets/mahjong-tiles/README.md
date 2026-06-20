# 立直麻将牌面（开源素材）

## 是什么
直接使用第三方**开源 CC0/公有领域**立直牌面 SVG 素材（位于 `tiles/`，含牌框/白板/牌背/点棒），由 `tiles.js` 做「编码 → 素材文件」的映射渲染。素材授权见 [NOTICE.md](NOTICE.md)。

## 编码
- `m` 万子 / `p` 筒子 / `s` 索子 / `z` 字牌
- `1-9m/p/s` 一~九；`1-7z` = 东 南 西 北 白 发 中
- `0m/0p/0s` = 赤五万 / 赤⑤饼 / 赤5索；`back` = 牌背

## 用法
```html
<script src="./tiles.js"></script>
<script>
  el.innerHTML = MJTiles.img("0m", { width: 60 });   // -> <img ...> 引用素材文件
  MJTiles.file("1z");                                  // -> "tan"（素材文件名）
  MJTiles.src("5p");                                   // -> "tiles/5pin.svg"
  MJTiles.parseHand("123m0p77z");                      // -> ["1m","2m","3m","0p","7z","7z"]
</script>
```
渲染用 `<img>` + `aspect-ratio:320/446`，按 `width` 任意缩放（素材根 `<svg>` 无 viewBox，故用固定纵横比贴合）。

## 预览
浏览器打开 `index.html`：全牌一览（每张标注编码+素材文件名）+ 自定义牌型渲染 + 深色背景切换。

## 备注
- 字牌 `tan=东(1z)`、`xia=西(3z)` 已通过渲染截图确认；如需对调，改 `HONOR` 一行即可。
- 应用和演示统一使用完整的 `tiles/`。

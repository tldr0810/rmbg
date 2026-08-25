# 去背品質基準測試 (quality baseline)

這個分支不進 `main`,只是把「去背品質到底好不好」這個問題的證據放在看得到的地方。

## 測的是什麼

`@imgly/background-removal@1.7.0` — 這個套件**已經在 `package.json` 裡**,但 `src/` 完全沒有用到它。
它跑的是 ISNet 模型,在瀏覽器裡用 WASM/WebGPU 執行,不呼叫任何 API、不花錢、圖片不離開使用者的電腦。

測試方式不是找一個「差不多的模型」來代替,而是**下載該套件實際使用的同一份權重**
(`isnet_fp16`,88,152,708 bytes,來自 `staticimgly.com/@imgly/background-removal-data/1.7.0/`),
再用 `imgly_repro.py` 一比一重現它的前後處理:

| 步驟 | 與 `dist/index.mjs` 對應 |
|---|---|
| 拉伸到 1024×1024 雙線性(不保持長寬比) | `runInference`,`keepAspect = false` |
| `(x - 128) / 256`,BCHW | `tensorHWCtoBCHW` 預設 mean/std |
| alpha × 255 | `convertFloat32ToUint8` |
| alpha 雙線性放回原尺寸 | `config.rescale` |

所以 `sheets/` 裡看到的,就是瀏覽器端會產出的東西。

## 結果

`sheets/*.png` 每張由左至右是:**原圖 | alpha 遮罩 | 去背結果(棋盤格底)**。

用棋盤格而不是白底,是因為白底會把最該看到的問題藏起來 —— 白邊、殘留背景、半透明破洞在白底上全都看起來「正常」。

| 測試圖 | 結果 |
|---|---|
| `sneaker` | 乾淨。飽和紅底沒有滲色白邊,電商去背等級 |
| `hair_curly` | 好。捲髮絲有保留,邊緣柔和 |
| `man_portrait` | 好。髮際線乾淨 |
| `woman_field` | 好。 |
| `dog_fur` | 好。毛髮邊緣正確,連狗咬著的花莖都留住了 |
| `pug` | 好。 |
| `plant` | **弱點**。多物件雜亂平拍:只認得「主體」,鏟子握把變半透明、剪刀整個被丟掉 |

`results.json` 有每張的 alpha 統計。`plant` 的 `soft_edge_pct` 是 17.49%,其他都在 3–8% ——
**這個數字可以當自動偵測「這張去得不好」的訊號**。

## 已知限制

ISNet 是 salient object detection:它找的是「畫面主體」,不是「所有前景物」。
單一主體(人、動物、商品)非常好;多物件平拍會挑一個、丟掉其他。

## 速度(這輪先不處理)

CPU 單張推論 0.56–0.93 秒。使用者端第一次要下載 88MB 模型(`isnet_quint8` 有 44MB 版本可換)。

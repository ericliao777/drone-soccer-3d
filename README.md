# 無人機足球・十大術科訓練場(3D 版)

依「無人機足球:10 大基礎術科操縱指南」設計的 3D 模擬飛行訓練遊戲,
基於 [jackize123/drone-soccer](https://github.com/jackize123/drone-soccer) 改造為 Three.js 3D 渲染。

**▶ 線上遊玩:https://ericliao777.github.io/drone-soccer-3d/**

## 遊戲內容

### 🚁🌏 無人機環台大冒險(`taiwan3d.html`)
HDRI 真實天光(Poly Haven CC0)打造的 ACT 闖關遊戲,以台灣五大景點為關卡:
台北101 夜空攀升 → 日月潭晨光巡航 → 阿里山巨木雲海 → 太魯閣峽谷迴廊 → 墾丁燈塔夕照。
穿光環、集星星、躲障礙(天燈/遊湖船/落石/海鷗),Shift 衝刺、三心扣血、星等評分與最速紀錄。

### ⚽ 十大術科訓練場(`keyboard.html` / `gamepad.html`)

## 特色

- **四種視角**:追機(預設)/ 第一人稱 FPV / 俯視 / 守門,`V` 鍵、手把 `R1` 或畫面按鈕切換
- **體育館場景**:觀眾席、聚光燈、草皮、廣告圍板;Bloom 泛光、即時陰影、ACES 色調映射
  (畫面左上「🏟️ 場景」按鈕可一鍵切回輕量模式,舊平板也能跑)
- **10 關術科訓練**:起飛懸停、四方位旋轉、定高巡航、正方形航路、急停、8 字、精準降落、守門擋球
- **兩種操作**:鍵盤/平板觸控(`keyboard.html`)、iPad + PS5 DualSense 手把(`gamepad.html`)
- **教學配套**:學員登記、星等評分、成績代碼、排行榜與 CSV 匯出、教學錄影頁
- **完全離線可用**:three.js 已內含,無任何 CDN 依賴,教室沒網路照樣玩

## 架構

| 檔案 | 職責 |
|---|---|
| `game-core.js` | 共用核心:物理、10 關任務邏輯、進度保存、排行榜。任務的 `draw(R)` 只發出顯示指令,與渲染解耦 |
| `render3d.js` | Three.js(r147)渲染層:場景、機身、四視角攝影機、粒子特效、HUD、後製 |
| `three-post.js` | Bloom 後製鏈(three.js r147 examples/js 打包) |
| `keyboard.html` / `gamepad.html` | 版面與輸入層(鍵盤+虛擬搖桿 / DualSense) |

## 本地開發

任何靜態伺服器皆可,例如:

```
python -m http.server 8734
```

開 `http://localhost:8734/` 即可。

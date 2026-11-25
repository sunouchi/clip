# Clip

A Chrome extension that captures the entire page and copies it to the clipboard with one press.

Press the toolbar button and the whole page, including everything below the fold, is on your clipboard as a PNG. No menu, no editor, no save dialog. A flash and a thumbnail tell you when it is there.

> "Clip" is a working name, and the extension is not on the Chrome Web Store yet. For now it is installed from source.

[日本語の説明は下にあります](#日本語)

## Use

| | Mac | Windows, Linux |
| --- | --- | --- |
| Capture the full page | Toolbar button, or `Command+Shift+1` | Toolbar button, or `Ctrl+Shift+1` |
| Capture the visible area | `Command+Shift+2` | `Ctrl+Shift+2` |

Both are also in the menu you get by right-clicking the toolbar button. Press `Esc` to cancel a capture. `Command+Shift+3` and `Command+Shift+4` are kept free for functions to come.

- **A flash and a green check mark** mean the image is on the clipboard.
- **A red exclamation mark** means the capture failed, with the reason next to it. On pages that Chrome does not let extensions touch, there is only the mark on the toolbar button; hover over it to read why.

## Install from source

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder.
4. Pin Clip to the toolbar.

Clip needs Chrome 157 or later.

If another extension already uses a shortcut, Chrome leaves it there and Clip gets none. Change either at `chrome://extensions/shortcuts`.

## How it works, and how long it takes

Clip scrolls through the page and joins screens into one PNG. Screens come from two sources:

- **Exact.** `chrome.tabs.captureVisibleTab()` returns a screen pixel for pixel. Chrome allows two of these per second.
- **Filmed.** For about 2.5 seconds' worth of screens, Clip waits for that limit. On longer pages, the screens it has no time to wait for are taken from a video of the tab (`chrome.tabCapture`), which takes about a tenth of a second each. The first and the last screen are always exact, and so is every other one the limit allows.

| Page height (CSS px) | Screens | Of these filmed | Image at 2x (Retina) | Time | All exact (version 0.2) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3,273 | 5 | 0 | 2560 × 6546 | 2.3 s | 2.3 s |
| 5,673 | 9 | 4 | 2560 × 11346 | 2.6 to 2.9 s | 3.6 s |
| 12,873 | 19 | 14 | 2560 × 25746 | 3.1 s | 9.9 s |
| 24,873 | 36 | 27 | 2560 × 49746 | 6.1 s | 18.8 s |

Measured in headless Chromium 159 on an Apple Silicon Mac with made-up test pages, in a window 713 CSS px tall inside. A taller window means fewer screens. Numbers from an ordinary Chrome window, and a comparison with other extensions, are still to come.

### Colors on long pages

Pages of up to about six screens are exact throughout. On longer ones, filmed screens can be off by a little, because video stores color more coarsely than brightness.

Clip corrects most of that. The exact screens tell it which color each video color stands for, so flat colors that also appear on an exact screen come out exactly right. What remains are steps of one or two in photos, gradients and colors Clip has not seen, and soft edges on colored text.

On a made-up page with text, cards, buttons and noisy pictures (22 screens, 15 of them filmed, 5.3 s instead of 12.2 s), 84.7% of all pixels were exactly right, 94.6% were within two steps out of 255, and 0.3% were off by more than 16.

### While it scrolls

- Headers, menus and bars that stay put while the page scrolls appear once: at the top of the image, or at the bottom for things pinned to the bottom of the window.
- Content that fades in as you scroll to it is captured fully visible. Images get a moment to load.
- Smooth scrolling and scroll snapping are out of the way during the capture.
- Afterwards the page is put back the way it was, scroll position included.

### Why not faster

`chrome.debugger` renders the whole page at once, in 0.3 to 2 seconds. Version 0.1 did that. But on every capture Chrome shows a bar saying that the extension started debugging the browser, and extensions cannot hide it.

## Permissions and privacy

| Permission | What for |
| --- | --- |
| `activeTab` | Capturing the tab you are on, only when you press the button or a shortcut |
| `scripting` | Scrolling that tab and showing the result in it |
| `clipboardWrite` | Putting the image on the clipboard |
| `contextMenus` | The menu on the toolbar button |
| `tabCapture`, `offscreen` | Filming that tab, without sound, while a long page is captured. Chrome may mark the tab as being captured for those few seconds |

Nothing is recorded: video frames go straight into the image. It makes no network requests, stores nothing and collects nothing. The image goes to your clipboard and nowhere else.

## What it does not do yet

- **Very long pages.** An image cannot be taller than 65,535 pixels (about 32,000 CSS px on a Retina display). Clip refuses such pages rather than producing a broken image.
- **Endless pages.** Clip follows a page that grows while it scrolls up to one and a half times the height it had at first, then stops and says so.
- **Browser pages.** Chrome does not let extensions scroll `chrome://` pages or the Chrome Web Store. The visible area of `chrome://` pages can be captured.
- **Pages that scroll inside a container.** Clip scrolls the document. If the page keeps its content in an inner scrolling area, only the visible part of that area is captured.
- **Filming in windows of an odd size.** Video comes in even sizes only. If the page area is an odd number of pixels wide or tall, which happens on displays that are not Retina, every screen is captured exactly, at two per second.
- **Pages that scroll sideways.** Only the part as wide as the window is captured.
- **Backgrounds fixed to the window** (`background-attachment: fixed`) repeat on every screen.

Planned next: saving to a file (PNG or JPEG), and an options page.

## Development

The extension is plain JavaScript with no build step and no dependencies. `extension/` is exactly what Chrome loads. The icons are drawn from the SVG files in `design/`.

The tests load the extension into a real Chromium, press its button on made-up pages, read the image back from the clipboard and check its pixels:

```sh
npm install
npx playwright install chromium
npm test
```

`npm run test:standard` runs the same tests at a device scale of 1 instead of 2. The tests run headless; in our runs the system clipboard was left untouched.

Screenshots can contain private information. Samples and test data in this repository come only from the made-up pages under `test/`.

## License

[MIT](LICENSE)

---

## 日本語

ページ全体を撮って、クリップボードにコピーする Chrome 拡張機能です。

ツールバーのボタンを押すと、スクロールしないと見えない部分も含めたページ全体が、PNG 画像としてクリップボードに入ります。メニューも、編集画面も、保存のダイアログも出ません。コピーできると、画面が一瞬光り、撮った画像の縮小版が出ます。

> 「Clip」は仮の名前です。Chrome ウェブストアにはまだ公開していません。いまはソースから入れて使います。

### 使い方

| | Mac | Windows・Linux |
| --- | --- | --- |
| ページ全体を撮る | ツールバーのボタン、または `Command+Shift+1` | ツールバーのボタン、または `Ctrl+Shift+1` |
| 表示中の範囲だけを撮る | `Command+Shift+2` | `Ctrl+Shift+2` |

どちらも、ツールバーのボタンを右クリックしたメニューにもあります。撮っている途中でやめるには、`Esc` を押します。`Command+Shift+3` と `Command+Shift+4` は、これから作る機能のために空けてあります。

- **画面が光り、緑のチェックが出たら**、画像がクリップボードに入っています。
- **赤い「!」が出たら**、失敗です。理由が横に出ます。拡張機能が触れないページでは、ツールバーのボタンにだけ「!」が出ます。ボタンにカーソルを載せると、理由が読めます。

### ソースから入れる

1. このリポジトリを clone します。
2. `chrome://extensions` を開き、**デベロッパー モード**を入れます。
3. **パッケージ化されていない拡張機能を読み込む**を押し、`extension` フォルダを選びます。
4. Clip をツールバーにピン留めします。

Chrome 157 以降が必要です。

ほかの拡張機能が同じショートカットキーを使っていると、Chrome はそちらを優先し、Clip には割り当てません。どちらかを `chrome://extensions/shortcuts` で変えてください。

### 仕組みと、かかる時間

Clip は、ページをスクロールしながら画面を撮り、1 枚の PNG につなぎます。画面の撮り方は 2 つあります。

- **正確な撮影。** `chrome.tabs.captureVisibleTab()` で、見えているとおりのピクセルを得ます。Chrome の制限で、1 秒に 2 回までです。
- **動画からの取り込み。** およそ 2.5 秒に収まるうちは、制限を待って正確に撮ります。それより長いページでは、待つ時間のない画面だけを、タブを映した動画（`chrome.tabCapture`）から取ります。1 画面およそ 0.1 秒です。最初と最後の画面は必ず正確に撮り、そのほかも、制限の範囲で撮れるものは正確に撮ります。

| ページの高さ（CSS px） | 画面の数 | うち動画 | 2 倍（Retina）の画像 | 時間 | すべて正確に撮ると（0.2） |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3,273 | 5 | 0 | 2560 × 6546 | 2.3 秒 | 2.3 秒 |
| 5,673 | 9 | 4 | 2560 × 11346 | 2.6〜2.9 秒 | 3.6 秒 |
| 12,873 | 19 | 14 | 2560 × 25746 | 3.1 秒 | 9.9 秒 |
| 24,873 | 36 | 27 | 2560 × 49746 | 6.1 秒 | 18.8 秒 |

Apple シリコンの Mac で、ヘッドレスの Chromium 159 と作り物のテストページを使って測りました。ウィンドウの内側の高さは 713 CSS px です。ウィンドウが高いほど、画面の数は減ります。ふだんの Chrome のウィンドウで測った数字と、ほかの拡張機能との比較は、これから載せます。

#### 長いページの色

およそ 6 画面までのページは、すべて正確です。それより長いページでは、動画から取った画面の色が、わずかにずれることがあります。動画は、色を明るさより粗く持つためです。

Clip は、そのほとんどを直します。正確に撮った画面と見比べて、動画の色がもとの何色にあたるかを覚えるので、正確な画面にも出てくるベタ塗りの色は、もとの色に戻ります。残るのは、写真・グラデーション・まだ見ていない色の 1〜2 段階のずれと、色の付いた文字の縁のにじみです。

文字・カード・ボタン・ざらついた写真風の絵を並べた作り物のページ（22 画面、うち動画 15 画面。12.2 秒が 5.3 秒に）では、画像全体の 84.7% のピクセルが完全に一致し、94.6% が 255 段階のうち 2 段階以内、16 段階を超えてずれたのは 0.3% でした。

#### スクロールしている間

- スクロールしても動かないヘッダー・メニュー・バーは、1 回だけ写します。上に固定されたものは画像の先頭に、下に固定されたものは画像の末尾に写ります。
- スクロールすると浮かび上がる内容は、出きった状態で写します。画像には、読み込む時間を少し与えます。
- 滑らかなスクロールと、位置の吸着は、撮る間だけ止めます。
- 撮り終えたら、スクロールの位置も含めて、ページを元に戻します。

#### もっと速くしない理由

`chrome.debugger` を使うと、ページ全体を一度に描かせて、0.3〜2 秒で撮れます。バージョン 0.1 はこの方法でした。ただし、撮るたびに「デバッグを開始しました」という帯を Chrome が出し、拡張機能の側からは消せません。

### 権限とプライバシー

| 権限 | 使い道 |
| --- | --- |
| `activeTab` | いま開いているタブを撮る。ボタンかショートカットキーを押したときだけ |
| `scripting` | そのタブをスクロールし、結果をその中に表示する |
| `clipboardWrite` | 画像をクリップボードに入れる |
| `contextMenus` | ツールバーのボタンのメニュー |
| `tabCapture`・`offscreen` | 長いページを撮る間、そのタブを動画として取り込む（音は取らない）。その数秒間、Chrome がタブに取り込み中の印を付けることがある |

録画はしません。動画のフレームは、そのまま画像になります。通信は一切しません。何も保存せず、何も集めません。画像はクリップボードに入るだけで、ほかのどこにも送られません。

### まだできないこと

- **とても長いページ。** 画像の高さは 65,535 ピクセルまでです（Retina の画面では、およそ 32,000 CSS px）。それを超えるページは、壊れた画像を作らず、撮れないと知らせます。
- **終わりのないページ。** スクロールすると伸びるページは、はじめの高さの 1.5 倍まで追いかけ、そこで止めて、そのことを知らせます。
- **ブラウザ自身のページ。** Chrome は、拡張機能が `chrome://` のページや Chrome ウェブストアをスクロールすることを認めていません。`chrome://` のページは、表示中の範囲なら撮れます。
- **内側の枠の中でスクロールするページ。** Clip がスクロールするのは文書の全体です。内容が内側のスクロール領域に入っているページでは、その領域の見えている部分だけが写ります。
- **大きさが奇数のウィンドウでの、動画からの取り込み。** 動画は偶数の大きさしか扱えません。ページの表示部分の幅か高さが奇数ピクセルのとき（Retina でない画面で起きます）は、すべての画面を、1 秒に 2 画面ずつ正確に撮ります。
- **横にスクロールするページ。** ウィンドウの幅の分だけが写ります。
- **ウィンドウに固定された背景**（`background-attachment: fixed`）は、1 画面ごとにくり返し写ります。

次に作る予定のもの: ファイル（PNG・JPEG）に保存する、設定ページ。

### 開発

拡張機能は素の JavaScript で、ビルドの工程も依存パッケージもありません。`extension/` が、そのまま Chrome に読み込まれます。アイコンは、`design/` の SVG ファイルから描き出しています。

テストは、本物の Chromium に拡張機能を読み込み、作り物のページでボタンを押し、クリップボードから画像を読み戻して、ピクセルを確かめます。

```sh
npm install
npx playwright install chromium
npm test
```

`npm run test:standard` は、同じテストを等倍（デバイスの倍率 1）で実行します。テストはヘッドレスで動きます。こちらで実行した範囲では、システムのクリップボードは変わりませんでした。

スクリーンショットには、個人の情報が写り込むことがあります。このリポジトリに置く見本とテストのデータは、`test/` にある作り物のページから作ったものだけにします。

### ライセンス

[MIT](LICENSE)

# Clip

A Chrome extension that captures the entire page in one shot and copies it to the clipboard.

Press the toolbar button and the whole page, including everything below the fold, is on your clipboard as a PNG. No menu, no editor, no save dialog.

> "Clip" is a working name, and the extension is not on the Chrome Web Store yet. For now it is installed from source.

[日本語の説明は下にあります](#日本語)

## Why it is fast

Most full-page screenshot extensions scroll the page, take a picture of each screen with `chrome.tabs.captureVisibleTab()` and stitch the pictures together. Chrome limits that call to two per second, so a page twenty screens tall takes ten seconds or more, however well the extension is written.

Clip does not scroll. It attaches the DevTools protocol to the tab and asks Chrome to render the whole page at once (`Page.captureScreenshot` with `captureBeyondViewport`).

Time from pressing the button to the image being on the clipboard, measured in headless Chromium 159 on an Apple Silicon Mac with made-up test pages:

| Page height (CSS px) | Image at 2x (Retina) | Time | Image at 1x | Time |
| ---: | ---: | ---: | ---: | ---: |
| 3,273 | 2560 × 6546 | 0.3 to 0.45 s | 1280 × 3273 | 0.27 s |
| 12,817 | 2560 × 25634 | 1.2 s | | |
| 24,817 | 2560 × 49634 | 2.1 s | 1280 × 24817 | 0.7 s |

Numbers from an ordinary Chrome window, and a comparison with scroll-and-stitch extensions, are still to come.

## The trade-off: Chrome's debugging bar

Using the DevTools protocol has a visible cost. While Clip captures, Chrome shows a bar across the top of the window saying that "Clip" started debugging this browser. In our tests it stays for about five seconds after the capture and then goes away by itself. Extensions cannot hide it; it is Chrome telling you what an extension is doing.

The bar matters for the capture in two ways, and Clip handles both:

- The bar slides in over about 150 ms and shrinks the page while it does. A capture taken during that time comes out corrupted, with the first screen repeated down the image. Clip waits until the page has stopped moving.
- A shorter window changes the layout of anything sized in viewport units, such as a `100vh` hero. Clip captures the page at the size it had before the bar appeared, so the image matches what you were looking at.

## Install from source

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder.
4. Pin Clip to the toolbar.

To capture, click the toolbar button or press `Alt+Shift+S` (`Option+Shift+S` on a Mac). If the shortcut was not assigned, or you want another one, set it at `chrome://extensions/shortcuts`.

A green check mark on the button means the image is on the clipboard. A red exclamation mark means the capture failed; hover over the button to read why.

## Permissions and privacy

Clip asks for one permission, `debugger`, and uses it for two things: rendering the page, and writing the image to the clipboard from inside the page.

It makes no network requests, stores nothing and collects nothing. The image goes to your clipboard and nowhere else.

## What it does not do yet

- **Very long pages.** An image cannot be taller than 65,535 pixels (about 32,000 CSS px on a Retina display). Clip refuses such pages rather than producing a broken image.
- **Pages over plain HTTP.** Browsers only offer the clipboard on HTTPS pages (and `localhost`).
- **Browser pages.** Chrome does not let extensions attach to `chrome://` URLs.
- **Pages that scroll inside a container.** Clip captures the document. If the page keeps its content in an inner scrolling area, only the visible part of that area is captured.
- **Images that load as you scroll.** If the page has not loaded an image yet, it is blank in the capture.
- **Pages taller than 16,384 device pixels** are captured in several pieces and joined, which is why long pages take longer in the table above.

Planned next: capturing only the visible area, saving to a file (PNG or JPEG), and an options page.

## Development

The extension is plain JavaScript with no build step and no dependencies. `extension/` is exactly what Chrome loads.

The tests load the extension into a real Chromium, capture made-up pages, read the image back from the clipboard and check its pixels:

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

ページ全体を一度に撮って、クリップボードにコピーする Chrome 拡張機能です。

ツールバーのボタンを押すと、スクロールしないと見えない部分も含めたページ全体が、PNG 画像としてクリップボードに入ります。メニューも、編集画面も、保存のダイアログも出ません。

> 「Clip」は仮の名前です。Chrome ウェブストアにはまだ公開していません。いまはソースから入れて使います。

### なぜ速いのか

ページ全体を撮る拡張機能の多くは、ページをスクロールしながら 1 画面ずつ撮り（`chrome.tabs.captureVisibleTab()`）、あとでつなぎ合わせます。Chrome はこの撮影を 1 秒に 2 回までに制限しているので、画面 20 枚ぶんのページなら、どれだけ上手に作っても 10 秒以上かかります。

Clip はスクロールしません。タブに DevTools プロトコルで接続し、Chrome にページ全体を一度に描かせます（`Page.captureScreenshot` の `captureBeyondViewport`）。

ボタンを押してから、画像がクリップボードに入るまでの時間です。Apple シリコンの Mac で、ヘッドレスの Chromium 159 と作り物のテストページを使って測りました。

| ページの高さ（CSS px） | 2 倍（Retina）の画像 | 時間 | 等倍の画像 | 時間 |
| ---: | ---: | ---: | ---: | ---: |
| 3,273 | 2560 × 6546 | 0.3〜0.45 秒 | 1280 × 3273 | 0.27 秒 |
| 12,817 | 2560 × 25634 | 1.2 秒 | | |
| 24,817 | 2560 × 49634 | 2.1 秒 | 1280 × 24817 | 0.7 秒 |

ふだんの Chrome のウィンドウで測った数字と、スクロールしてつなぐ方式の拡張機能との比較は、これから載せます。

### 引き換えにしたもの: Chrome の「デバッグ中」の帯

DevTools プロトコルを使う代わりに、目に見える代償があります。Clip が撮っている間、Chrome はウィンドウの上部に「"Clip" がこのブラウザのデバッグを開始しました」という帯を出します。こちらのテストでは、撮り終えてから 5 秒ほど残り、そのあと自動で消えました。拡張機能の側からこの帯を消すことはできません。拡張機能が何をしているかを、Chrome が利用者に知らせるためのものです。

この帯は、撮影に 2 つの影響を与えます。Clip はどちらにも対処しています。

- 帯は 150 ミリ秒ほどかけて出てきて、その間ページを縮めます。この途中で撮ると、最初の 1 画面が下までくり返された、壊れた画像になります。Clip は、ページの動きが止まるのを待ってから撮ります。
- ウィンドウが低くなると、画面の高さを基準にした部分（`100vh` のヒーローなど）のレイアウトが変わります。Clip は、帯が出る前の大きさでページを撮るので、見ていたとおりの画像になります。

### ソースから入れる

1. このリポジトリを clone します。
2. `chrome://extensions` を開き、**デベロッパー モード**を入れます。
3. **パッケージ化されていない拡張機能を読み込む**を押し、`extension` フォルダを選びます。
4. Clip をツールバーにピン留めします。

撮るには、ツールバーのボタンを押すか、`Alt+Shift+S`（Mac は `Option+Shift+S`）を押します。ショートカットキーが割り当てられていないときや、変えたいときは、`chrome://extensions/shortcuts` で設定します。

ボタンに緑のチェックが出たら、画像がクリップボードに入っています。赤い「!」が出たら失敗です。ボタンにカーソルを載せると、理由が読めます。

### 権限とプライバシー

Clip が求める権限は `debugger` の 1 つだけです。ページを描かせることと、ページの中からクリップボードに画像を書くことの 2 つに使います。

通信は一切しません。何も保存せず、何も集めません。画像はクリップボードに入るだけで、ほかのどこにも送られません。

### まだできないこと

- **とても長いページ。** 画像の高さは 65,535 ピクセルまでです（Retina の画面では、およそ 32,000 CSS px）。それを超えるページは、壊れた画像を作らず、撮れないと知らせます。
- **HTTPS でないページ。** ブラウザは、HTTPS のページ（と `localhost`）でしかクリップボードを使わせません。
- **ブラウザ自身のページ。** Chrome は、拡張機能が `chrome://` のページに接続することを認めていません。
- **内側の枠の中でスクロールするページ。** Clip が撮るのは文書の全体です。内容が内側のスクロール領域に入っているページでは、その領域の見えている部分だけが写ります。
- **スクロールすると読み込まれる画像。** まだ読み込まれていない画像は、空白のまま写ります。
- **16,384 デバイスピクセルより長いページ**は、いくつかに分けて撮ってつなぎます。上の表で長いページに時間がかかっているのは、このためです。

次に作る予定のもの: 表示中の範囲だけを撮る、ファイル（PNG・JPEG）に保存する、設定ページ。

### 開発

拡張機能は素の JavaScript で、ビルドの工程も依存パッケージもありません。`extension/` が、そのまま Chrome に読み込まれます。

テストは、本物の Chromium に拡張機能を読み込み、作り物のページを撮り、クリップボードから画像を読み戻して、ピクセルを確かめます。

```sh
npm install
npx playwright install chromium
npm test
```

`npm run test:standard` は、同じテストを等倍（デバイスの倍率 1）で実行します。テストはヘッドレスで動きます。こちらで実行した範囲では、システムのクリップボードは変わりませんでした。

スクリーンショットには、個人の情報が写り込むことがあります。このリポジトリに置く見本とテストのデータは、`test/` にある作り物のページから作ったものだけにします。

### ライセンス

[MIT](LICENSE)

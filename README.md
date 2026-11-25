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

Both are also in the menu you get by right-clicking the toolbar button. Press `Esc` to cancel a capture.

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

Clip scrolls through the page, captures one screen at a time with `chrome.tabs.captureVisibleTab()` and joins the screens into one PNG. Chrome allows two of these captures per second. Clip does everything else in between, so the time depends on almost nothing but the number of screens:

| Page height (CSS px) | Screens | Image at 2x (Retina) | Time |
| ---: | ---: | ---: | ---: |
| 3,273 | 5 | 2560 × 6546 | 2.3 s |
| 5,673 | 8 | 2560 × 11346 | 3.6 s |
| 12,873 | 19 | 2560 × 25746 | 9.9 s |
| 24,873 | 36 | 2560 × 49746 | 18.8 s |

Measured in headless Chromium 159 on an Apple Silicon Mac with made-up test pages, in a window 713 CSS px tall inside. A taller window means fewer screens. Numbers from an ordinary Chrome window, and a comparison with other extensions, are still to come.

While it scrolls, Clip keeps the page presentable:

- Headers, menus and bars that stay put while the page scrolls appear once: at the top of the image, or at the bottom for things pinned to the bottom of the window.
- Content that fades in as you scroll to it is captured fully visible. Images get a moment to load.
- Smooth scrolling and scroll snapping are out of the way during the capture.
- Afterwards the page is put back the way it was, scroll position included.

### Why not faster

Two faster ways were tried.

- **`chrome.debugger`** renders the whole page at once, in 0.3 to 2 seconds. Version 0.1 did that. But on every capture Chrome shows a bar saying that the extension started debugging the browser, and extensions cannot hide it.
- **`chrome.tabCapture`** films the tab, and delivered a screen in 10 to 50 ms. But video is compressed into fewer colors: in a test page hardly a pixel kept its exact color, and colored text came out blurred.

## Permissions and privacy

| Permission | What for |
| --- | --- |
| `activeTab` | Capturing the tab you are on, only when you press the button or a shortcut |
| `scripting` | Scrolling that tab and showing the result in it |
| `clipboardWrite` | Putting the image on the clipboard |
| `contextMenus` | The menu on the toolbar button |

It makes no network requests, stores nothing and collects nothing. The image goes to your clipboard and nowhere else.

## What it does not do yet

- **Very long pages.** An image cannot be taller than 65,535 pixels (about 32,000 CSS px on a Retina display). Clip refuses such pages rather than producing a broken image.
- **Endless pages.** Clip follows a page that grows while it scrolls up to one and a half times the height it had at first, then stops and says so.
- **Browser pages.** Chrome does not let extensions scroll `chrome://` pages or the Chrome Web Store. The visible area of `chrome://` pages can be captured.
- **Pages that scroll inside a container.** Clip scrolls the document. If the page keeps its content in an inner scrolling area, only the visible part of that area is captured.
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

どちらも、ツールバーのボタンを右クリックしたメニューにもあります。撮っている途中でやめるには、`Esc` を押します。

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

Clip は、ページをスクロールしながら `chrome.tabs.captureVisibleTab()` で 1 画面ずつ撮り、1 枚の PNG につなぎます。Chrome はこの撮影を 1 秒に 2 回までに制限しています。ほかの処理はその合間に済ませるので、かかる時間は、ほぼ画面の数で決まります。

| ページの高さ（CSS px） | 画面の数 | 2 倍（Retina）の画像 | 時間 |
| ---: | ---: | ---: | ---: |
| 3,273 | 5 | 2560 × 6546 | 2.3 秒 |
| 5,673 | 8 | 2560 × 11346 | 3.6 秒 |
| 12,873 | 19 | 2560 × 25746 | 9.9 秒 |
| 24,873 | 36 | 2560 × 49746 | 18.8 秒 |

Apple シリコンの Mac で、ヘッドレスの Chromium 159 と作り物のテストページを使って測りました。ウィンドウの内側の高さは 713 CSS px です。ウィンドウが高いほど、画面の数は減ります。ふだんの Chrome のウィンドウで測った数字と、ほかの拡張機能との比較は、これから載せます。

スクロールしている間、Clip はページの見た目を整えます。

- スクロールしても動かないヘッダー・メニュー・バーは、1 回だけ写します。上に固定されたものは画像の先頭に、下に固定されたものは画像の末尾に写ります。
- スクロールすると浮かび上がる内容は、出きった状態で写します。画像には、読み込む時間を少し与えます。
- 滑らかなスクロールと、位置の吸着は、撮る間だけ止めます。
- 撮り終えたら、スクロールの位置も含めて、ページを元に戻します。

#### もっと速くしない理由

速い方法を 2 つ試しました。

- **`chrome.debugger`** は、ページ全体を一度に描かせる方法で、0.3〜2 秒で撮れます。バージョン 0.1 はこの方法でした。ただし、撮るたびに「デバッグを開始しました」という帯を Chrome が出し、拡張機能の側からは消せません。
- **`chrome.tabCapture`** は、タブを動画として取り込む方法で、1 画面が 10〜50 ミリ秒で届きました。ただし、動画は色の情報が減らされます。テストのページでは、元と同じ色のままのピクセルはほとんどなく、色の付いた文字がにじみました。

### 権限とプライバシー

| 権限 | 使い道 |
| --- | --- |
| `activeTab` | いま開いているタブを撮る。ボタンかショートカットキーを押したときだけ |
| `scripting` | そのタブをスクロールし、結果をその中に表示する |
| `clipboardWrite` | 画像をクリップボードに入れる |
| `contextMenus` | ツールバーのボタンのメニュー |

通信は一切しません。何も保存せず、何も集めません。画像はクリップボードに入るだけで、ほかのどこにも送られません。

### まだできないこと

- **とても長いページ。** 画像の高さは 65,535 ピクセルまでです（Retina の画面では、およそ 32,000 CSS px）。それを超えるページは、壊れた画像を作らず、撮れないと知らせます。
- **終わりのないページ。** スクロールすると伸びるページは、はじめの高さの 1.5 倍まで追いかけ、そこで止めて、そのことを知らせます。
- **ブラウザ自身のページ。** Chrome は、拡張機能が `chrome://` のページや Chrome ウェブストアをスクロールすることを認めていません。`chrome://` のページは、表示中の範囲なら撮れます。
- **内側の枠の中でスクロールするページ。** Clip がスクロールするのは文書の全体です。内容が内側のスクロール領域に入っているページでは、その領域の見えている部分だけが写ります。
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

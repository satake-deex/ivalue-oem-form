# ivalue OEM先 フォーム営業

インクレイブ様「ivalue」の OEM パートナー候補（印刷会社・採用支援・WEB制作）への問い合わせフォーム営業。送信者は deex 佐竹。

| ファイル | 中身 |
|---|---|
| `targets_spec.md` | リスト作成の仕様（対象・件数・除外・形式） |
| `templates.json` | フォーム文面（業種別 A/B） |
| `sender.json` | 送信者情報（佐竹 h.satake@deex.co.jp）。フォーム入力と返信先に使う |
| `targets.json` | 送付先リスト（作成予定） |
| `send.js` | 送信スクリプト（渡邉さんの実装を流用。Windows・sender.json・業種別A/B・営業お断り判定に対応） |
| `package.json` | `npm install` で playwright-core を入れる |
| `results.jsonl` | 送付結果の台帳 |

## 送信の手順（Windows）

PC に Google Chrome が入っていること。初回だけ `npm install`。

```powershell
node send.js --dry --limit 5          # 入力まで（送らない）。shots/ のスクショで送信者・本文を目視確認
node send.js --limit 40 --conc 3      # 本番。has_web: true の会社から順に送る
node send.js --retry-fail             # fail_* だけ再試行
```

- 台帳 `results.jsonl` に1社1行。載ったドメインには二度と送らない（`variant` に A/B どちらの文面かを記録）
- CAPTCHA・営業お断り・本文の文字数上限が短いフォームは送らずスキップ
- `STOP` という名前のファイルを置くと即停止
- Chrome が標準の場所にない場合は `$env:CHROME_PATH="C:\path\to\chrome.exe"` を先に実行

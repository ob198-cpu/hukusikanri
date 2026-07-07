# 受給者証・サービス更新期限管理システム Google Sheets保存

このフォルダは、`https://ob198-cpu.github.io/hukusikanri/` の入力内容をGoogleスプレッドシートへ保存するための Google Apps Script です。

保存先スプレッドシート:

`1DNvKBKSmnKg7eU0T7T_46Qz5ib1phGFzG8yxdPQCUyw`

## 作成されるシート

- `Users`: 利用者の基本情報
- `Deadlines`: 計画相談・サービス期限
- `MonitoringRecords`: モニタリング・請求・受領通知チェック
- `History`: 操作履歴
- `State`: 最終保存時刻

## 反映手順

1. Google Apps Script で新規プロジェクトを作成
2. `Code.gs` と `appsscript.json` を貼り付け
3. デプロイ > 新しいデプロイ > 種類「ウェブアプリ」
4. 実行ユーザー: 自分
5. アクセスできるユーザー: 全員
6. 発行された `/exec` URLを、システムのバックアップ画面「Apps Script WebアプリURL」に保存

URL保存後は、利用者データを保存するたびにGoogle Sheetsへ送信されます。

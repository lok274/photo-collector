# 收相盒

讓訪客從手機揀選相片及影片，把原檔交到 `bwc-ykl@bwflc.edu.hk` 的 Google Drive。訪客毋須登入 Google，只需收相人私下提供的上傳碼。每個檔案各自顯示上傳進度及儲存結果，斷線後可在原頁按「重試」續傳。

收相頁為 [GitHub Pages 收相盒](https://lok274.github.io/photo-collector/)，原始碼放在 [lok274/photo-collector](https://github.com/lok274/photo-collector) 的 `github-pages` 分支。GitHub Pages 提供網頁；Google Apps Script 以擁有人身分驗證及寫入 Drive。

**截止時間為香港時間 2026 年 11 月 9 日 23:59:00，即 `2026-11-09T23:59:00+08:00`。請在截止前完成上傳；截止後未完成的檔案不能繼續傳送。已收到的檔案會保留。** 後端在每次準備、查進度及傳分段前檢查伺服器時間，上傳碼及憑證都不能繞過截止。

## 格式及容量

- 每個檔案最多 2 GB，程式精確上限為 2 GiB，即 2,147,483,648 bytes。每批最多 30 個檔案。
- 相片支援 JPEG、PNG、WebP、GIF、HEIC、HEIF、AVIF、TIFF 及 DNG。Apple ProRAW 及 Android RAW 的 DNG 以 TIFF 家族標頭識別。
- 影片支援 MP4、MOV、WebM 及 3GP。MP4 及 MOV 保留原有 H.264、HEVC 等編碼，不轉碼。MOV 同時識別 `ftyp` 及常見舊式 QuickTime 首個 atom。
- 能否預覽取決於手機瀏覽器及編碼。不能預覽仍可交原檔；影片預覽不會自動播放。這個程式不保證每種編碼都能在瀏覽器播放。
- 所有訪客每日合共 20 GiB，按香港時間午夜重設。這是本程式設定，不是 Google 的服務承諾。

手機相簿可能在交出檔案前轉換格式。程式保留收到的原檔，不壓縮，也不移除拍攝時間、地點等資料。

## 沿用現有 Google 後端

接收帳戶固定為 `bwc-ykl@bwflc.edu.hk`。**沿用現有 Apps Script 專案及 `COLLECTOR_CONFIG`。不要刪除或重建設定，不要另建收相資料夾，不要把上傳碼或簽署密鑰放進 GitHub。** 現有 `BACKEND_URL` 已填入正式 `/exec` 網址，更新部署應沿用該網址。

1. 在現有專案更新 `Code.gs` 及 `appsscript.json`。Advanced Drive service 必須保留 `Drive`、版本 `v3`。
2. OAuth 範圍只有 `https://www.googleapis.com/auth/drive.file` 及 `https://www.googleapis.com/auth/script.external_request`。前者存取本程式建立的 Drive 檔案；後者讓伺服器以 HTTPS 將小分段傳到 Google Drive resumable upload API。新增第二個範圍後，須由接收帳戶完成重新授權。
3. 現有專案毋須重新初始化。`setup_()` 重跑會保留已有資料夾、上傳碼、簽署密鑰及容量紀錄。全新專案才需要首次設定，並私下取得上傳碼。
4. 在「部署」→「管理部署作業」更新現有網頁應用程式到新版本。執行身分為擁有人，有權存取的人須包含未登入的任何人。`/dev` 不是正式訪客網址。
5. 到 Drive 檢查資料夾「共用」設定。一般存取權必須是「受限制」，只保留擁有人指定的協作者。學校帳戶可能有預設網域分享，不能因為程式新建資料夾便假設它已私人化。
6. 真實上傳一個測試檔後，也要檢查該檔案本身的共用設定及繼承權限。不要把收相資料夾改成知道連結的任何人均可查看。

Google Workspace 管理員可能限制匿名部署或外部要求。如果學校不容許匿名網頁應用程式，GitHub Pages 無法繞過此限制。

## GitHub Pages 與手機使用

Pages 來源應為 `github-pages` 分支根目錄，入口為小寫 `index.html`，並保留 `.nojekyll`。前後端固定使用 `https://lok274.github.io` 來源；改網域時須同步更新及重部署。直接開本機檔案或其他來源只會進入預覽，不會嘗試上傳。

1. 從已發布的 GitHub Pages 網址開啟收相頁，貼上上傳碼。
2. 揀選相片及影片，核對檔名、預覽及大小。
3. 按「上傳」，保持原頁開啟及手機亮屏，直到每個檔案顯示「已儲存」。
4. 斷線或結果不明時，在截止前按該檔案的「重試」。程式先問 Google 已收到多少，再從已確認位置續傳。
5. 「清除已儲存項目」只清理本機頁面的清單，不會刪除 Drive 檔案。

未確認的憑證會保留在原頁；程式不會自動重送寫入或換新編號。重新整理、關頁或手機清除頁面會失去進度。憑證在簽發 24 小時後或收相截止時過期，以較早者為準。憑證或上傳連線過期、遺失或已截止時，先請收相人到 Drive 核對；只有尚未截止才可重新選取，避免重複收檔。

## 分段、核對與容量紀錄

瀏覽器只讀取前 64 KiB 計算 SHA-256，準備上傳時由伺服器核對標頭及該段雜湊。其後逐段讀取最多 4 MiB，以隱藏表單 POST 到 Apps Script，再由伺服器傳到 Drive。瀏覽器不會一次讀入或雜湊整個 2 GiB 檔案。標頭檢查只排除明顯假冒格式，並非完整圖片或影片解碼，也不是病毒掃描或全檔 SHA-256 驗證。

每個頁面項目只產生一次隨機 `uploadKey`。伺服器預先產生 Drive 檔案編號，簽署的憑證綁定檔名、格式、大小、標頭雜湊、上傳編號及到期時間。Drive session URI 和擁有人 OAuth token 只留在伺服器，不會交給瀏覽器；所有分段都須經過上傳碼及截止檢查。

準備上傳時先在鎖定狀態下記錄整檔容量預留及憑證，再開始 Drive session。準備回覆遺失後，以相同 `uploadKey` 重試會沿用原檔案編號及預留。結果不明、失敗或放棄上傳都不退回額度，因此 20 GiB 可能早於實際收到的容量用完。這個保守做法避免不明結果反覆佔用未計算的容量。

Drive 回傳的 Range 決定續傳位置，程式不會假設整段已收到。只有核對 Drive 的檔案編號、檔名、MIME、完整大小、目標資料夾及憑證標記全部相符，才顯示「已儲存」。最後回覆遺失後也可用原憑證核對。完成及過期的暫存 session 紀錄會清理，清理不會刪除已收檔案；最多同時保留 64 個未完成 session，避免指令碼屬性儲存空間溢出。

POST 只接受 `prepareUpload`、`getUploadStatus` 及 `uploadChunk`。公開入口只有 `doGet` 和 `doPost`，不提供訪客檔案清單、下載、刪除或分享。後端以 `postMessage` 回覆固定來源；前端驗證 Google 來源、每次隨機編號、操作名稱及資料格式。每次等候最多兩分鐘，逾時不會聲稱成功，也不會自動重送。

知道上傳碼的人仍可消耗 Drive 空間及 Google 配額。每個 2 GiB 檔案最多需要 512 個資料分段，另加準備及查進度要求；Apps Script 的執行次數、外部要求及時間配額仍適用。這不是無限容量的媒體收集服務。

## 檢查與實測界線

在此資料夾執行以下指令，不須安裝套件。

```text
node verify.mjs
```

模擬測試檢查來源及憑證驗證、截止前後、2 GiB 上限、支援格式標頭、分段大小及編碼、308 部分進度、遺失回覆後續傳、不重複扣額度、完成檔案核對、設定保留、前端小段讀取、預覽、固定來源及逾時清理。

**模擬測試不能證明真實 2 GiB 手機上傳已可用。** 本版仍須在正式部署後，以未登入 Google 的瀏覽器測試錯碼、相片、影片及超過兩段的檔案，核對擁有人 Drive 中的內容、大小及分享權限，再用實際 Apple／Android 手機及接近 2 GiB 的檔案測試。網絡、手機背景暫停、學校政策及 Google 配額都可能令上傳失敗；不要把程式設定上限當成已實測的容量保證。

Google 官方參考包括 [Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable)、[Advanced Drive service](https://developers.google.com/apps-script/advanced/drive)、[UrlFetchApp](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app)、[預先產生檔案編號](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds)、[網頁應用程式部署](https://developers.google.com/apps-script/guides/web)，以及 [Apps Script 配額](https://developers.google.com/apps-script/guides/services/quotas)。

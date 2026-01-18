// ===== ここを自分の値に書き換える（1）: LIFF ID =====
const LIFF_ID = "2008513371-Xr0AYLvA";

// ===== グローバル変数 =====
let db = null; // Firestore
let currentUser = null; // { lineUserId, displayName }
let currentEventId = null; // 選択中イベントID
let currentEventData = null; // 現在表示中のイベントデータ
let lineupCandidates = []; // 出席（◎/〇）メンバー一覧
let lineupStarting = []; // 保存済みスタメン

// 助っ人用の固定ID＆表示名
const GUEST_MEMBER_ID = "guest-player"; // なんでもOK。被らないIDにする
const GUEST_MEMBER_NAME = "助っ人";

// HTMLエスケープ（XSS対策）
function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 日時表示用（Firestore Timestamp → "MM/DD HH:MM"）
function formatDateTime(ts) {
    try {
        const d = ts.toDate(); // Firestore Timestamp → Date
        return d.toLocaleString("ja-JP", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch (e) {
        return "";
    }
}

// 日付表示用（Date → "YYYY-MM-DD"）
function formatDate(d) {
    if (!(d instanceof Date)) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

// "YYYY-MM-DD"（または "YYYY-MM-DD(○)"）から「YYYY-MM-DD(日)」のような表示文字列を返す
function formatDateWithWeekdayString(dateStr) {
    if (!dateStr) return "";
    // 先頭10文字だけを「年月日」として扱う（古いデータで "(日)" などが付いていてもOKにする）
    const base = dateStr.slice(0, 10);
    const parts = base.split("-");
    if (parts.length !== 3) return dateStr;

    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if (!y || !m || !d) return dateStr;

    const dateObj = new Date(y, m - 1, d);
    if (isNaN(dateObj.getTime())) return dateStr;

    const weekdayMap = "日月火水木金土";
    const w = weekdayMap[dateObj.getDay()];

    const mm = String(m).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    return `${y}-${mm}-${dd}(${w})`;
}

// "YYYY-MM-DD" から曜日インデックス(0=日曜)を返す
function getWeekdayIndex(dateStr) {
    if (!dateStr) return null;
    const base = dateStr.slice(0, 10);
    const parts = base.split("-");
    if (parts.length !== 3) return null;
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if (!y || !m || !d) return null;
    const dateObj = new Date(y, m - 1, d);
    if (isNaN(dateObj.getTime())) return null;
    return dateObj.getDay();
}

// 管理者の LINE userId
const ADMIN_IDS = [
    "U046402ee4c1ae926ba9b5b2e950deedc",
    "Uab4c0e41bfa51cf34ce6991988d19484",
    "U50662d04a3559ea2d85e763d239d8a46",
    "U694f4ec6add0b0553dfc75b851a29da5",
];

// ★ 追加：現在のユーザーが管理者かどうか
function isCurrentUserAdmin() {
    return currentUser && ADMIN_IDS.includes(currentUser.lineUserId);
}

// 出席扱いにするステータス
const ATTEND_OK_STATUSES = ["present", "late"];

// ========== URL から eventId を取得 ==========
function getEventIdFromUrl() {
    const params = new URLSearchParams(window.location.search);

    // ① ?eventId=... で開いた場合
    const direct = params.get("eventId");
    if (direct && direct.trim() !== "") {
        console.log("URL から eventId を取得（direct）:", direct);
        return direct.trim();
    }

    // ② LIFF の deep link (?liff.state=/eventId=...) の場合
    const liffState = params.get("liff.state");
    if (liffState) {
        const innerParams = new URLSearchParams(liffState);
        const fromLiff = innerParams.get("eventId");
        if (fromLiff && fromLiff.trim() !== "") {
            console.log("URL から eventId を取得（liff.state）:", fromLiff);
            return fromLiff.trim();
        }
    }

    console.log("eventId が見つからないので 一覧モード で表示");
    return null;
}

// ========== ステータス → 表示ラベル ==========
function convertStatusToLabel(status) {
    switch (status) {
        case "present":
            return { label: "◎ 出席", color: "green" };
        case "late":
            return { label: "〇 遅刻", color: "orange" };
        case "undecided":
            return { label: "△ 未定", color: "blue" };
        case "absent":
            return { label: "✖ 欠席", color: "red" };
        case "no_response":
        default:
            return { label: "未回答", color: "gray" };
    }
}

// ========== イベント種別 → 表示ラベル ==========
function convertEventTypeLabel(type) {
    switch (type) {
        case "official":
            return "公式戦";
        case "practiceGame":
            return "練習試合";
        case "practice":
            return "練習";
        case "other":
            return "その他イベント";
        default:
            return "";
    }
}

// ========== 単一イベント保存・汎用保存 ==========
async function saveAttendanceFor(eventId, status) {
    if (!eventId || !currentUser) return;

    const docId = `${eventId}_${currentUser.lineUserId}`;
    const ref = db.collection("attendance").doc(docId);

    await ref.set(
        {
            eventId,
            lineUserId: currentUser.lineUserId,
            status,
            updatedAt: new Date(),
        },
        { merge: true }
    );
}

// 詳細画面用（currentEventId を使う）
async function saveAttendance(status) {
    return saveAttendanceFor(currentEventId, status);
}

// ========== 自分の出欠を一覧表示 ==========
async function loadMyAttendance() {
    const container = document.getElementById("my-attendance-table");
    if (!container) return;
    container.textContent = "読み込み中…";

    // すべてのイベントを取得（日時順）
    const eventsSnap = await db.collection("events").orderBy("date").get();

    if (eventsSnap.empty) {
        container.textContent = "イベントが登録されていません。";
        return;
    }

    // 自分の出欠だけを取得
    const attSnap = await db
        .collection("attendance")
        .where("lineUserId", "==", currentUser.lineUserId)
        .get();

    // { eventId: status } のマップ
    const myStatusMap = {};
    attSnap.forEach((doc) => {
        const a = doc.data();
        myStatusMap[a.eventId] = a.status;
    });

    // 今日（0:00）を基準に過去／これからを分ける
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let upcomingRows = ""; // 今日以降
    let pastRows = ""; // 過去イベント

    eventsSnap.forEach((doc) => {
        const e = doc.data();
        const eventId = doc.id;
        const status = myStatusMap[eventId] || "no_response";
        const info = convertStatusToLabel(status); // { label, color }

        // 行 HTML（元のテーブル行をそのまま関数内で作成）
        const displayDate = formatDateWithWeekdayString(e.date || "");
        const rowHtml = `
      <tr>
        <td>${escapeHtml(e.date || "")}</td>
        <td>${escapeHtml(e.title || "")}</td>
        <td>
          <div style="display:flex; gap:4px; flex-wrap:wrap; align-items:center;">
            <button class="my-att-btn ${status === "present" ? "is-present" : ""
            }"
              data-event-id="${eventId}" data-status="present">◎</button>
            <button class="my-att-btn ${status === "late" ? "is-late" : ""}"
              data-event-id="${eventId}" data-status="late">〇</button>
            <button class="my-att-btn ${status === "undecided" ? "is-undecided" : ""
            }"
              data-event-id="${eventId}" data-status="undecided">△</button>
            <button class="my-att-btn ${status === "absent" ? "is-absent" : ""}"
              data-event-id="${eventId}" data-status="absent">✖</button>
            <span class="my-att-status-label" style="color:${info.color};">
              現在：${info.label}
            </span>
          </div>
        </td>
      </tr>`;

        // 過去イベントかどうか判定
        let isPast = false;
        const baseDateStrForMy = (e.date || "").slice(0, 10); // "YYYY-MM-DD"
        if (baseDateStrForMy) {
            const d = new Date(baseDateStrForMy);
            d.setHours(0, 0, 0, 0);
            if (d < today) isPast = true;
        }

        if (isPast) {
            pastRows += rowHtml;
        } else {
            upcomingRows += rowHtml;
        }
    });

    // 画面全体の HTML を組み立て
    let html = "";

    // これからのイベント（常に表示）
    if (upcomingRows) {
        html += `
      <h3 class="event-list-title">これからのイベント</h3>
      <table class="my-att-table">
        <thead>
          <tr>
            <th>日付</th>
            <th>タイトル</th>
            <th>自分の出欠</th>
          </tr>
        </thead>
        <tbody>
          ${upcomingRows}
        </tbody>
      </table>`;
    }

    // 過去のイベント（アコーディオン）
    html += `
      <details class="past-events" ${upcomingRows ? "" : "open"}>
        <summary>過去のイベントを表示 / 非表示</summary>
        ${pastRows
            ? `<table class="my-att-table" style="margin-top: 8px;">
                     <thead>
                       <tr>
                         <th>日付</th>
                         <th>タイトル</th>
                         <th>自分の出欠</th>
                       </tr>
                     </thead>
                     <tbody>
                       ${pastRows}
                     </tbody>
                   </table>`
            : `<p style="margin-top:8px;">過去のイベントはありません。</p>`
        }
      </details>`;

    container.innerHTML = html;

    // クリックしたときに出欠を保存（これから＋過去の両方に効く）
    container.querySelectorAll(".my-att-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const eventId = btn.dataset.eventId;
            const status = btn.dataset.status;
            await saveAttendanceFor(eventId, status);
            await loadMyAttendance(); // 再読み込みして表示を更新
        });
    });
}

// ========== LIFF 初期化 & ユーザー情報取得 ==========
async function initLiff() {
    await liff.init({ liffId: LIFF_ID });

    if (!liff.isLoggedIn()) {
        liff.login();
        return;
    }

    const profile = await liff.getProfile();
    currentUser = {
        lineUserId: profile.userId,
        displayName: profile.displayName,
    };
    console.log("LIFFログインユーザー:", currentUser);
}

// ========== members 登録 ==========
async function ensureMember() {
    const docRef = db.collection("members").doc(currentUser.lineUserId);
    const doc = await docRef.get();

    if (!doc.exists) {
        await docRef.set({
            name: currentUser.displayName,
            createdAt: new Date(),
            isActive: true,
        });
        console.log("新規メンバーを登録しました");
    } else {
        console.log("既存メンバーです");
    }
}

// イベント一覧の読み込み
async function loadEventList() {
    console.log("loadEventList() 開始")
    const listDiv = document.getElementById("event-list")
    if (!listDiv) {
        console.error("event-list 要素が見つかりません");
        return;
    }

    listDiv.innerHTML = "読み込み中…";
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);

    try {
        // イベント一覧を日付順で取得
        const [snap, membersSnap, attSnap] = await Promise.all([
            db.collection("events").orderBy("date").get(),
            db.collection("members").get(),
            db.collection("attendance").get(),
        ]);
        console.log("events 取得件数:", snap.size);

        if (snap.empty) {
            listDiv.textContent = "イベントが登録されていません。";
            return;
        }

        const membersMap = {};
        membersSnap.forEach((doc) => {
            const m = doc.data();
            membersMap[doc.id] = m.name || "名前未設定";
        });

        const miniAttendanceMap = {};

        attSnap.forEach((doc) => {
            const a = doc.data();
            if (!a.eventId || !a.status) return;

            if (!miniAttendanceMap[a.eventId]) {
                miniAttendanceMap[a.eventId] = {
                    present: [],
                    late: [],
                    undecided: [],
                    absent: [],
                };
            }
            const memberName = membersMap[a.lineUserId] || "名前未設定";
            if (miniAttendanceMap[a.eventId][a.status]) {
                miniAttendanceMap[a.eventId][a.status].push(memberName);
            }

        });

        let upcomingRows = ""; // 今日以降
        let pastRows = ""; // 過去
        const upcomingRowList = [];

        const miniAttendanceHtml = (eventId) => {
            const statusRows = [
                { key: "present", label: "◎", showNames: true },
                { key: "late", label: "〇", showNames: true },
                { key: "undecided", label: "△", showNames: false },
                { key: "absent", label: "✖", showNames: false },
            ];
            return statusRows
                .map(({ key, label, showNames }) => {
                    const names = (miniAttendanceMap[eventId]?.[key] || [])
                        .slice()
                        .sort((a, b) => a.localeCompare(b, "ja-JP"));
                    const nameText = showNames
                        ? names.length
                            ? names.map((name) => escapeHtml(name)).join(", ")
                            : "-"
                        : `${names.length}人`;
                    return `
            <div class="mini-attendance-row">
              <span class="mini-attendance-label">${label}</span>
              <span class="mini-attendance-names">${nameText}</span>
            </div>`;
                })
                .join("");
        };

        snap.forEach((doc) => {
            const data = doc.data();
            const id = doc.id;

            const rawDateStr = data.date || ""; // Firestore に保存されている値
            const formattedDate = formatDateWithWeekdayString(rawDateStr); // 表示用 "YYYY-MM-DD(日)"
            let yearPart = "";
            let monthDayPart = "";

            if (formattedDate && formattedDate.length >= 11) {
                yearPart = formattedDate.slice(0, 4); // 2025
                monthDayPart = formattedDate.slice(5); // 12-21(日)
            }

            const weekdayIndex = getWeekdayIndex(rawDateStr);
            let weekdayClass = "";
            if (weekdayIndex === 0) {
                weekdayClass = " is-sun";
            } else if (weekdayIndex === 6) {
                weekdayClass = " is-sat";
            }

            // 参加人数カウント（◎ = present, ◯ = late）
            const time = data.time || "";
            const place = data.place || "";
            const title = data.title || "";

            const rowHtml = `
        <tr>
          <td class="event-date${weekdayClass}">
            <div>${escapeHtml(yearPart)}</div>
            <div>${escapeHtml(monthDayPart)}</div>
          </td>
          <td class="event-main">
            <div class="event-title">${escapeHtml(title)}</div>
            <div class="event-sub">${escapeHtml(time)}　｜　${escapeHtml(
                place
            )}</div>
            <div class="mini-attendance">
              ${miniAttendanceHtml(id)}
            </div>
          </td>
          <td class="event-action">
            <button class="open-event-btn" data-event-id="${id}">開く</button>
          </td>
        </tr>`;

            // 過去イベントかどうか判定
            let isPast = false;
            const baseDateStr = (rawDateStr || "").slice(0, 10); // "YYYY-MM-DD"
            if (baseDateStr) {
                const d = new Date(baseDateStr);
                d.setHours(0, 0, 0, 0);
                if (d < todayDate) isPast = true;
            }

            if (isPast) {
                pastRows += rowHtml;
            } else {
                upcomingRows += rowHtml;
                upcomingRowList.push(rowHtml);
            }
        });

        // HTML を組み立て
        let html = "";
        const UPCOMING_VISIBLE_LIMIT = 3;
        const upcomingVisibleRows = upcomingRowList
            .slice(0, UPCOMING_VISIBLE_LIMIT)
            .join("");
        const upcomingHiddenRows = upcomingRowList
            .slice(UPCOMING_VISIBLE_LIMIT)
            .join("");

        // これからのイベント（常に表示）
        if (upcomingRowList.length > 0) {
            html += `
      <h3 class="event-list-title">これからのイベント</h3>
      <table class="event-table">
        <thead>
          <tr>
            <th>日付</th>
            <th>内容</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${upcomingVisibleRows}
        </tbody>
      </table>`;
        }

        if (upcomingHiddenRows) {
            html += `
      <details class="upcoming-events-toggle">
        <summary>すべて表示する</summary>
        <table class="event-table" style="margin-top: 8px;">
          <thead>
            <tr>
              <th>日付</th>
              <th>内容</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${upcomingHiddenRows}
          </tbody>
        </table>
      </details>`;
        }

        // 過去のイベント（アコーディオン）
        html += `
      <details class="past-events" ${upcomingRows ? "" : "open"}>
        <summary>過去のイベントを表示 / 非表示</summary>
        ${pastRows
                ? `<table class="event-table" style="margin-top: 8px;">
                     <thead>
                       <tr>
                         <th>日付</th>
                         <th>内容</th>
                         <th>操作</th>
                       </tr>
                     </thead>
                     <tbody>
                       ${pastRows}
                     </tbody>
                   </table>`
                : `<p style="margin-top:8px;">過去のイベントはありません。</p>`
            }
      </details>`;

        listDiv.innerHTML = html;

        // 「開く」ボタンにイベントIDを紐付け
        listDiv.querySelectorAll(".open-event-btn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                const id = e.currentTarget.dataset.eventId;
                console.log("イベントを開く:", id);
                location.search = `?eventId=${encodeURIComponent(id)}`;
            });
        });

        console.log("loadEventList() 正常終了");
    } catch (e) {
        console.error("loadEventList() でエラー:", e);
        listDiv.textContent =
            "イベント一覧の取得に失敗しました。コンソールを確認してください。";
    }
}

// 一覧 ←→ 詳細 の戻るボタン
function setupBackButton() {
    const backBtn = document.getElementById("back-to-list-btn");
    if (!backBtn) return;

    backBtn.addEventListener("click", () => {
        location.search = ""; // クエリを消して再読み込み → 一覧モード
    });
}

// ========== 特定イベントの情報読み込み ==========
async function loadEvent() {
    console.log("loadEvent currentEventId:", currentEventId);

    const eventRef = db.collection("events").doc(currentEventId);
    const snap = await eventRef.get();
    const eventDiv = document.getElementById("event-info");

    if (!snap.exists) {
        eventDiv.innerHTML = `
      <p>イベントID「${currentEventId}」のデータが Firestore にありません。</p>
      <p>Cloud Firestore の <code>events</code> コレクションに
      同じ ID のドキュメントを作成してください。</p>`;
        return;
    }

    const data = snap.data();
    currentEventData = { id: currentEventId, ...data }; // ★ ここで保持

    const typeLabel = convertEventTypeLabel(data.type);
    const displayDate = formatDateWithWeekdayString(data.date || "");

    eventDiv.innerHTML = `
<p><strong>試合名：</strong>${escapeHtml(data.title || "")}</p>
<p><strong>日時：</strong>${escapeHtml(displayDate)} ${escapeHtml(
        data.time || ""
    )}</p>
    <p><strong>場所：</strong>${escapeHtml(data.place || "")}</p>
    ${typeLabel ? `<p><strong>種別：</strong>${escapeHtml(typeLabel)}</p>` : ""}
    <p><strong>メモ：</strong>${escapeHtml(data.note || "")}</p>`;

    // ★ 種別に応じてオーダーエリアを表示
    await setupLineupSectionIfNeeded();
}

// ========== 出欠一覧 ==========
async function loadAttendanceList() {
    const listDiv = document.getElementById("attendance-list");
    listDiv.innerHTML = "読み込み中…";

    const membersSnap = await db.collection("members").get();
    const attendanceSnap = await db
        .collection("attendance")
        .where("eventId", "==", currentEventId)
        .get();

    const statusMap = {};
    attendanceSnap.forEach((doc) => {
        const a = doc.data();
        statusMap[a.lineUserId] = a.status;
    });

    const counters = {
        present: 0,
        late: 0,
        undecided: 0,
        absent: 0,
        no_response: 0,
    };

    let html =
        "<table border='1' style='border-collapse: collapse; width: 100%;'>";
    html += "<tr><th>メンバー</th><th>ステータス</th></tr>";

    membersSnap.forEach((doc) => {
        const m = doc.data();
        const id = doc.id;
        const status = statusMap[id] || "no_response";

        if (counters[status] !== undefined) {
            counters[status]++;
        } else {
            counters.no_response++;
        }

        const { label, color } = convertStatusToLabel(status);

        html += `
      <tr>
        <td>${m.name}</td>
        <td style="color:${color}; font-weight:bold;">${label}</td>
      </tr>`;
    });

    html += "</table>";
    listDiv.innerHTML = html;

    // 集計表示
    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };
    setText("sum-present", counters.present);
    setText("sum-late", counters.late);
    setText("sum-undecided", counters.undecided);
    setText("sum-absent", counters.absent);
    setText("sum-noresp", counters.no_response);
}

// ========== オーダー（ラインナップ） ==========

// 種別が 公式戦 or 練習試合 のときだけオーダーを表示
async function setupLineupSectionIfNeeded() {
    const block = document.getElementById("lineup-block");
    const editor = document.getElementById("lineup-editor");
    const saveBtn = document.getElementById("lineup-save-btn");
    if (!block || !editor) return;

    if (!currentEventData) {
        block.style.display = "none";
        return;
    }

    const type = currentEventData.type || "";
    const isGame = type === "official" || type === "practiceGame";
    if (!isGame) {
        block.style.display = "none";
        return;
    }

    const isAdmin = isCurrentUserAdmin();
    const lineup = currentEventData.lineup || {};
    const isPublished = !!lineup.isPublished;

    // ★ 管理者以外 & 非公開 → そもそも表示しない
    if (!isAdmin && !isPublished) {
        block.style.display = "none";
        return;
    }

    block.style.display = "block";

    // ボタンは管理者以外には非表示
    if (saveBtn) {
        saveBtn.style.display = isAdmin ? "inline-block" : "none";
    }

    editor.textContent = "読み込み中…";

    if (isAdmin) {
        // 管理者：編集用フォーム
        await loadLineupEditor();
        if (saveBtn && !saveBtn.dataset.listenerAdded) {
            saveBtn.addEventListener("click", saveLineup);
            saveBtn.dataset.listenerAdded = "1";
        }
    } else {
        // 一般メンバー：閲覧専用
        await loadLineupReadonly();
    }
}

// 出席（◎/〇）メンバーを候補として読み込み & 行を描画（管理者用）
async function loadLineupEditor() {
    const editor = document.getElementById("lineup-editor");
    if (!editor) return;

    try {
        const [membersSnap, attendanceSnap] = await Promise.all([
            db.collection("members").get(),
            db
                .collection("attendance")
                .where("eventId", "==", currentEventId)
                .get(),
        ]);

        const membersMap = {};
        membersSnap.forEach((doc) => {
            const m = doc.data();
            membersMap[doc.id] = m.name || "名前未設定";
        });

        const statusMap = {};
        attendanceSnap.forEach((doc) => {
            const a = doc.data();
            statusMap[a.lineUserId] = a.status;
        });

        // ◎ or 〇 のメンバーだけ候補にする
        lineupCandidates = Object.keys(statusMap)
            .filter((uid) => ATTEND_OK_STATUSES.includes(statusMap[uid]))
            .map((uid) => ({
                id: uid,
                name: membersMap[uid] || "名前未設定",
            }));

        lineupCandidates.sort((a, b) => a.name.localeCompare(b.name, "ja-JP"));

        // ★ 助っ人を常に候補に追加（出欠に関係なく）
        lineupCandidates.push({
            id: GUEST_MEMBER_ID,
            name: GUEST_MEMBER_NAME,
        });

        const lineup = (currentEventData && currentEventData.lineup) || {};

        lineupStarting = Array.isArray(lineup.starting) ? lineup.starting : [];
        const system = lineup.system || "NORMAL9";
        const memo = lineup.memo || "";
        const isPublished = !!lineup.isPublished;

        if (lineupCandidates.length === 0) {
            editor.innerHTML =
                "<p>出席（◎）または遅刻（〇）のメンバーがいません。<br>まず出欠を登録してください。</p>";
            return;
        }

        editor.innerHTML = `
        <div class="lineup-system-row">
          <label>打順人数
            <select id="lineup-system-select">
              <option value="NORMAL9"${system === "NORMAL9" ? " selected" : ""
            }>9人制</option>
              <option value="DH10"${system === "DH10" ? " selected" : ""
            }>DH制（10人打ち）</option>
              <option value="DH11"${system === "DH11" ? " selected" : ""
            }>DH制（11人打ち）</option>
              <option value="DH12"${system === "DH12" ? " selected" : ""
            }>DH制（12人打ち）</option>
              <option value="DH13"${system === "DH13" ? " selected" : ""
            }>DH制（13人打ち）</option>
              <option value="DH14"${system === "DH14" ? " selected" : ""
            }>DH制（14人打ち）</option>
              <option value="DH15"${system === "DH15" ? " selected" : ""
            }>DH制（15人打ち）</option>
            </select>
          </label>
        </div>

        <div class="lineup-publish-row">
          <label>
            <input type="checkbox" id="lineup-publish-checkbox"${isPublished ? " checked" : ""
            }>
            オーダーをメンバーに公開する
          </label>
        </div>

        <div id="lineup-rows-container"></div>

        <div class="lineup-memo-row">
          <label>メモ（継投・守備変更など）
            <textarea id="lineup-memo" rows="2"
              placeholder="例: 永久ベンチ→中橋、三振したら#21交代">${escapeHtml(
                memo
            )}</textarea>
          </label>
        </div>
      `;

        const systemSelect = document.getElementById("lineup-system-select");
        const rerender = () => renderLineupRows(systemSelect.value);
        systemSelect.addEventListener("change", rerender);
        rerender();
    } catch (e) {
        console.error("loadLineupEditor error:", e);
        editor.textContent =
            "オーダー情報の読み込みに失敗しました。時間をおいて再度お試しください。";
    }
}

// system に応じて 1〜9 or 10〜15 行の打順フォームを描画
function renderLineupRows(system) {
    const container = document.getElementById("lineup-rows-container");
    if (!container) return;

    // ★ system から最大打順を決める
    //   NORMAL9 → 9
    //   DH10〜DH15 → 10〜15
    let maxOrder = 9;
    if (system && system.startsWith("DH")) {
        const num = Number(system.replace("DH", ""));
        maxOrder = isNaN(num) ? 10 : num; // 想定外の値ならとりあえず10
    }

    // ★ 守備に「ベンチ」を追加
    const positions = [
        "投",
        "捕",
        "一",
        "二",
        "三",
        "遊",
        "左",
        "中",
        "右",
        "DH",
        "ベンチ",
    ];

    let html =
        '<table class="lineup-table"><thead><tr><th>打順</th><th>名前</th><th>守備</th></tr></thead><tbody>';

    for (let order = 1; order <= maxOrder; order++) {
        const existing = lineupStarting.find((p) => p.order === order) || {};
        const selectedMemberId = existing.memberId || "";
        // ★ デフォルト守備は空。必要に応じて「DH」や「ベンチ」を手動で選択
        const selectedPos = existing.position || "";

        html += `<tr class="lineup-row" data-order="${order}">`;
        html += `<td>${order}</td>`;

        // 名前 select
        html += `<td><select class="lineup-player-select">`;
        html += `<option value="">（選手を選択）</option>`;
        lineupCandidates.forEach((m) => {
            html += `<option value="${m.id}"${m.id === selectedMemberId ? " selected" : ""
                }>${escapeHtml(m.name)}</option>`;
        });
        html += `</select></td>`;

        // 守備 select
        html += `<td><select class="lineup-pos-select">`;
        html += `<option value="">ー</option>`;
        positions.forEach((pos) => {
            html += `<option value="${pos}"${pos === selectedPos ? " selected" : ""
                }>${pos}</option>`;
        });
        html += `</select></td>`;

        html += `</tr>`;
    }

    html += "</tbody></table>";
    container.innerHTML = html;
}

// 一般メンバー向け：閲覧専用のオーダー表示
async function loadLineupReadonly() {
    const editor = document.getElementById("lineup-editor");
    if (!editor) return;

    const lineup = (currentEventData && currentEventData.lineup) || {};
    const starting = Array.isArray(lineup.starting) ? [...lineup.starting] : [];

    if (!starting.length) {
        editor.innerHTML = "<p>まだオーダーが登録されていません。</p>";
        return;
    }

    // 打順順にソート
    starting.sort((a, b) => (a.order || 0) - (b.order || 0));

    // メンバー名取得
    const membersSnap = await db.collection("members").get();
    const nameMap = {};
    membersSnap.forEach((doc) => {
        const m = doc.data();
        nameMap[doc.id] = m.name || "名前未設定";
    });

    let html =
        '<table class="lineup-table"><thead><tr><th>打順</th><th>名前</th><th>守備</th></tr></thead><tbody>';

    starting.forEach((p) => {
        const name = nameMap[p.memberId] || "";
        html += `<tr><td>${p.order}</td><td>${escapeHtml(
            name
        )}</td><td>${escapeHtml(p.position || "")}</td></tr>`;
    });

    html += "</tbody></table>";

    if (lineup.memo) {
        html += `<div class="lineup-memo-display">
          <strong>メモ：</strong>${escapeHtml(lineup.memo)}
        </div>`;
    }

    editor.innerHTML = html;
}

// 保存ボタン押下時の処理（管理者のみ）
async function saveLineup() {
    if (!isCurrentUserAdmin()) {
        alert("オーダーを編集できるのは管理者のみです。");
        return;
    }

    const block = document.getElementById("lineup-block");
    const systemSelect = document.getElementById("lineup-system-select");
    const memoEl = document.getElementById("lineup-memo");
    const publishCheckbox = document.getElementById("lineup-publish-checkbox");
    if (!block || !systemSelect) {
        alert("オーダー入力欄が見つかりません。");
        return;
    }

    const system = systemSelect.value || "NORMAL9";
    const memo = memoEl ? memoEl.value.trim() : "";
    const isPublished = publishCheckbox ? publishCheckbox.checked : false;

    const rows = block.querySelectorAll(".lineup-row");
    const starting = [];

    rows.forEach((row) => {
        const order = Number(row.dataset.order);
        const playerSelect = row.querySelector(".lineup-player-select");
        const posSelect = row.querySelector(".lineup-pos-select");

        if (!playerSelect || !playerSelect.value) return;

        starting.push({
            order,
            memberId: playerSelect.value,
            position: posSelect && posSelect.value ? posSelect.value : "",
        });
    });

    try {
        await db.collection("events").doc(currentEventId).set(
            {
                lineup: {
                    system,
                    starting,
                    memo,
                    isPublished,
                },
            },
            { merge: true }
        );

        // メモリ上の currentEventData も更新
        currentEventData.lineup = {
            system,
            starting,
            memo,
            isPublished,
        };
        lineupStarting = starting;

        alert("オーダーを保存しました！");
    } catch (e) {
        console.error("saveLineup error:", e);
        alert(
            "オーダー保存中にエラーが発生しました。コンソールを確認してください。"
        );
    }
}

// ========== 出欠登録ボタン（詳細画面） ==========
function setupButtons() {
    const buttons = document.querySelectorAll("#buttons button");
    buttons.forEach((btn) => {
        btn.addEventListener("click", async () => {
            const status = btn.dataset.status;
            await saveAttendance(status);
            alert("出欠を登録しました！");
            await loadAttendanceList();
            await setupLineupSectionIfNeeded();
        });
    });
}

// 管理者用：削除対象イベントのセレクトを埋める
async function populateDeleteEventSelect() {
    const select = document.getElementById("delete-event-select");
    if (!select) return;

    // 一旦クリアして、先頭にプレースホルダを入れる
    select.innerHTML =
        '<option value="">-- イベントを選択してください --</option>';

    // 日付順に events コレクションを取得
    const snap = await db.collection("events").orderBy("date").get();

    snap.forEach((doc) => {
        const e = doc.data();
        const opt = document.createElement("option");

        // value は eventId（ドキュメント ID）
        opt.value = doc.id;

        // 表示用ラベル
        const parts = [];
        if (e.date) parts.push(e.date);
        if (e.title) parts.push(e.title);
        opt.textContent = parts.join(" ") + ` (${doc.id})`;

        select.appendChild(opt);
    });
}

// 管理者用：編集対象イベントのセレクトを埋める
async function populateEditEventSelect() {
    const select = document.getElementById("admin-edit-select");
    if (!select) return;

    select.innerHTML = '<option value="">新規作成（何も選択しない）</option>';

    const snap = await db.collection("events").orderBy("date").get();

    snap.forEach((doc) => {
        const e = doc.data();
        const opt = document.createElement("option");

        opt.value = doc.id;

        const parts = [];
        if (e.date) parts.push(e.date);
        if (e.title) parts.push(e.title);
        opt.textContent = parts.join(" ") + ` (${doc.id})`;

        select.appendChild(opt);
    });
}

// 管理者用：選択したイベントをフォームに読み込む
async function loadEventToAdminForm(eventId) {
    const idInput = document.getElementById("admin-event-id");
    const titleInput = document.getElementById("admin-title");
    const dateInput = document.getElementById("admin-date");
    const timeInput = document.getElementById("admin-time");
    const placeInput = document.getElementById("admin-place");
    const noteInput = document.getElementById("admin-note");
    const typeSelect = document.getElementById("admin-type");
    const msgEl = document.getElementById("admin-message");

    if (
        !idInput ||
        !titleInput ||
        !dateInput ||
        !timeInput ||
        !placeInput ||
        !noteInput
    ) {
        console.error("管理者用フォームの要素が見つかりません");
        return;
    }

    // 何も選んでいない ⇒ 新規作成モード
    if (!eventId) {
        idInput.disabled = false;
        idInput.value = "";
        titleInput.value = "";
        dateInput.value = "";
        timeInput.value = "";
        placeInput.value = "";
        noteInput.value = "";
        if (typeSelect) typeSelect.value = "";
        if (msgEl) {
            msgEl.textContent =
                "新しいイベントを追加します。必要事項を入力して「イベントを保存」を押してください。";
        }
        return;
    }

    // 既存イベントの読み込み
    try {
        const snap = await db.collection("events").doc(eventId).get();
        if (!snap.exists) {
            if (msgEl) {
                msgEl.textContent =
                    "指定されたイベントが見つかりませんでした。";
            }
            return;
        }

        const e = snap.data();

        idInput.disabled = true; // 既存IDは変更不可
        idInput.value = eventId;
        titleInput.value = e.title || "";
        dateInput.value = e.date || "";
        timeInput.value = e.time || "";
        placeInput.value = e.place || "";
        noteInput.value = e.note || "";
        if (typeSelect) typeSelect.value = e.type || "";

        if (msgEl) {
            msgEl.textContent =
                "既存イベントの内容を読み込みました。編集後に「イベントを保存」を押すと上書きされます。";
        }
    } catch (err) {
        console.error("loadEventToAdminForm error:", err);
        if (msgEl) {
            msgEl.textContent =
                "イベント情報の読み込み中にエラーが発生しました。";
        }
    }
}

// 管理者用：イベントを新規作成／編集して保存
async function createEventFromAdmin() {
    const eventIdInput = document.getElementById("admin-event-id");
    const eventId = eventIdInput.value.trim();
    const title = document.getElementById("admin-title").value.trim();
    const date = document.getElementById("admin-date").value.trim();
    const time = document.getElementById("admin-time").value.trim();
    const place = document.getElementById("admin-place").value.trim();
    const note = document.getElementById("admin-note").value.trim();
    const typeSelect = document.getElementById("admin-type");
    const type = typeSelect ? typeSelect.value : "";
    const msgEl = document.getElementById("admin-message");
    const editSelect = document.getElementById("admin-edit-select");
    const editingEventId = editSelect ? editSelect.value : "";

    if (!eventId) {
        alert("イベントIDを入力してください");
        return;
    }
    if (!title || !date || !time) {
        alert("試合名・日付・時間は必須です");
        return;
    }

    try {
        await db
            .collection("events")
            .doc(eventId)
            .set(
                {
                    title,
                    date,
                    time,
                    place,
                    note,
                    type: type || "",
                },
                { merge: true } // 既存の lineup などは保持
            );

        const shareUrl = `https://liff.line.me/${LIFF_ID}?eventId=${encodeURIComponent(
            eventId
        )}`;

        msgEl.textContent =
            (editingEventId
                ? "イベントを更新しました。\n"
                : "イベントを保存しました。\n") +
            `このURLをメンバーに共有してください：\n${shareUrl}`;

        // 各リストを更新
        await populateDeleteEventSelect();
        await populateEditEventSelect();
        await loadEventList();

        // 新規作成だった場合はフォームをクリア
        if (!editingEventId) {
            eventIdInput.disabled = false;
            eventIdInput.value = "";
            document.getElementById("admin-title").value = "";
            document.getElementById("admin-date").value = "";
            document.getElementById("admin-time").value = "";
            document.getElementById("admin-place").value = "";
            document.getElementById("admin-note").value = "";
            if (typeSelect) typeSelect.value = "";
        }
    } catch (e) {
        console.error("createEventFromAdmin error:", e);
        alert(
            "イベント保存中にエラーが発生しました。時間をおいて再度お試しください。"
        );
    }
}

// 管理者用：選択したイベントをフォームに読み込む
async function loadEventToAdminForm(eventId) {
    const idInput = document.getElementById("admin-event-id");
    const titleInput = document.getElementById("admin-title");
    const dateInput = document.getElementById("admin-date");
    const timeInput = document.getElementById("admin-time");
    const placeInput = document.getElementById("admin-place");
    const noteInput = document.getElementById("admin-note");
    const typeSelect = document.getElementById("admin-type");
    const msgEl = document.getElementById("admin-message");

    if (
        !idInput ||
        !titleInput ||
        !dateInput ||
        !timeInput ||
        !placeInput ||
        !noteInput
    ) {
        console.error("管理者用フォームの要素が見つかりません");
        return;
    }

    // 何も選んでいない ⇒ 新規作成モード
    if (!eventId) {
        idInput.disabled = false;
        idInput.value = "";
        titleInput.value = "";
        dateInput.value = "";
        timeInput.value = "";
        placeInput.value = "";
        noteInput.value = "";
        if (typeSelect) typeSelect.value = "";
        if (msgEl) {
            msgEl.textContent =
                "新しいイベントを追加します。必要事項を入力して「イベントを保存」を押してください。";
        }
        return;
    }

    // 既存イベントの読み込み
    try {
        const snap = await db.collection("events").doc(eventId).get();
        if (!snap.exists) {
            if (msgEl) {
                msgEl.textContent =
                    "指定されたイベントが見つかりませんでした。";
            }
            return;
        }

        const e = snap.data();

        idInput.disabled = true; // 既存IDは変更不可
        idInput.value = eventId;
        titleInput.value = e.title || "";
        dateInput.value = e.date || "";
        timeInput.value = e.time || "";
        placeInput.value = e.place || "";
        noteInput.value = e.note || "";
        if (typeSelect) typeSelect.value = e.type || "";

        if (msgEl) {
            msgEl.textContent =
                "既存イベントの内容を読み込みました。編集後に「イベントを保存」を押すと上書きされます。";
        }
    } catch (err) {
        console.error("loadEventToAdminForm error:", err);
        if (msgEl) {
            msgEl.textContent =
                "イベント情報の読み込み中にエラーが発生しました。";
        }
    }
}

// 管理者：イベント削除
async function deleteEventFromAdmin() {
    const select = document.getElementById("delete-event-select");
    const msgEl = document.getElementById("admin-message");

    if (!select) {
        alert("内部エラー：削除用のイベント選択欄が見つかりません。");
        return;
    }

    const eventId = select.value;
    if (!eventId) {
        alert("削除するイベントを選択してください。");
        return;
    }

    if (
        !confirm(
            "本当にこのイベントを削除しますか？\n関連する出欠データもすべて削除されます。"
        )
    ) {
        return;
    }

    try {
        msgEl.textContent = "イベント削除中です…";

        const eventRef = db.collection("events").doc(eventId);
        const eventSnap = await eventRef.get();

        if (!eventSnap.exists) {
            msgEl.textContent =
                "指定されたイベントIDのデータが見つかりませんでした。";
            return;
        }

        // Firestore のバッチで「events 本体」と「attendance の関連データ」を削除
        const batch = db.batch();

        batch.delete(eventRef);

        const attSnap = await db
            .collection("attendance")
            .where("eventId", "==", eventId)
            .get();

        attSnap.forEach((doc) => {
            batch.delete(doc.ref);
        });

        await batch.commit();

        msgEl.textContent = `イベントID「${eventId}」と、その出欠データを削除しました。`;

        // セレクトと一覧を更新
        await populateDeleteEventSelect();
        await populateEditEventSelect();
        await loadEventList();

        // 編集フォームでこのイベントを表示していたらリセット
        const editSelect = document.getElementById("admin-edit-select");
        if (editSelect && editSelect.value === eventId) {
            editSelect.value = "";
            await loadEventToAdminForm("");
        }
    } catch (e) {
        console.error("deleteEventFromAdmin() error:", e);
        msgEl.textContent =
            "削除中にエラーが発生しました。コンソールを確認してください。";
        alert("削除に失敗しました。時間をおいて再度お試しください。");
    }
}

// 管理者パネルの表示とイベントリスナー設定
function showAdminPanelIfNeeded() {
    if (!currentUser) return;
    const isAdmin = ADMIN_IDS.includes(currentUser.lineUserId);
    console.log(
        "showAdminPanelIfNeeded: currentUser =",
        currentUser,
        "isAdmin =",
        isAdmin
    );
    if (!isAdmin) return; // 管理者以外は何も表示しない

    const panel = document.getElementById("admin-panel");
    if (!panel) return;
    panel.style.display = "block";

    // イベント削除カードを表示
    const delCard1 = document.getElementById("admin-event-delete-card");
    const delCard2 = document.getElementById("admin-event-delete");
    if (delCard1) delCard1.style.display = "block";
    if (delCard2) delCard2.style.display = "block";

    // セレクトを初期化
    populateDeleteEventSelect().catch(console.error);
    populateEditEventSelect().catch(console.error);

    // 保存ボタン
    const saveBtn = document.getElementById("admin-save-btn");
    if (saveBtn && !saveBtn.dataset.listenerAdded) {
        saveBtn.addEventListener("click", (e) => {
            e.preventDefault();
            createEventFromAdmin();
        });
        saveBtn.dataset.listenerAdded = "1";
    }

    // 削除ボタン
    const deleteBtn = document.getElementById("admin-delete-btn");
    if (deleteBtn && !deleteBtn.dataset.listenerAdded) {
        deleteBtn.addEventListener("click", (e) => {
            e.preventDefault();
            deleteEventFromAdmin();
        });
        deleteBtn.dataset.listenerAdded = "1";
        console.log("delete ボタンにリスナーを設定しました");
    }

    // 編集対象セレクト
    const editSelect = document.getElementById("admin-edit-select");
    if (editSelect && !editSelect.dataset.listenerAdded) {
        editSelect.addEventListener("change", (e) => {
            const selectedEventId = e.target.value;
            loadEventToAdminForm(selectedEventId);
        });
        editSelect.dataset.listenerAdded = "1";
    }
}

// ========== 出席率ランキング ==========
async function loadStats(resultDiv) {
    const membersSnap = await db
        .collection("members")
        .where("isActive", "==", true)
        .get();

    if (membersSnap.empty) {
        resultDiv.textContent = "メンバーが登録されていません。";
        return;
    }

    const statsByMember = {};
    membersSnap.forEach((doc) => {
        statsByMember[doc.id] = {
            userId: doc.id,
            name: doc.data().name || "名無し",
            attendCount: 0,
        };
    });

    const eventsSnap = await db.collection("events").get();
    const totalEvents = eventsSnap.size;

    if (totalEvents === 0) {
        resultDiv.textContent = "イベントがまだ登録されていません。";
        return;
    }

    const attendanceSnap = await db.collection("attendance").get();
    attendanceSnap.forEach((doc) => {
        const a = doc.data();
        const memberStat = statsByMember[a.lineUserId];
        if (!memberStat) return;

        if (ATTEND_OK_STATUSES.includes(a.status)) {
            memberStat.attendCount += 1;
        }
    });

    const rows = Object.values(statsByMember).map((st) => {
        const rate = (st.attendCount / totalEvents) * 100;
        return {
            ...st,
            totalEvents,
            rate: Math.round(rate * 10) / 10,
        };
    });

    rows.sort((a, b) => b.rate - a.rate);

    let html =
        "<table border='1' style='border-collapse: collapse; width: 100%;'>";
    html +=
        "<tr><th>順位</th><th>名前</th><th>参加回数</th><th>イベント数</th><th>出席率</th></tr>";

    rows.forEach((row, index) => {
        html += `
      <tr>
        <td>${index + 1}</td>
        <td>${row.name}</td>
        <td style="text-align: right;">${row.attendCount}</td>
        <td style="text-align: right;">${row.totalEvents}</td>
        <td style="text-align: right;">${row.rate}%</td>
      </tr>`;
    });

    html += "</table>";
    resultDiv.innerHTML = html;
}

// 管理者だけランキングパネルを見せる
function showStatsPanelIfNeeded() {
    if (!currentUser) return;
    if (!ADMIN_IDS.includes(currentUser.lineUserId)) return;

    const panel = document.getElementById("stats-panel");
    if (!panel) return;

    panel.style.display = "block";

    const btn = document.getElementById("load-stats-btn");
    const resultDiv = document.getElementById("stats-result");
    if (!btn || !resultDiv) return;

    btn.addEventListener("click", async () => {
        resultDiv.textContent = "集計中です…";
        try {
            await loadStats(resultDiv);
        } catch (e) {
            console.error(e);
            resultDiv.textContent = "集計中にエラーが発生しました。";
        }
    });
}

// ========== みんなのメモ ==========
// メモ機能用
const MEMO_PAGE_SIZE = 10; // 一度に読み込む件数
let memoLastVisible = null; // 最後に取得したドキュメント
let memoListInitialized = false; // イベント委譲の初期化フラグ

// メモカードのセットアップ（一覧モードで呼び出す）
function setupMemoSection() {
    const card = document.getElementById("memo-card");
    const textarea = document.getElementById("memo-input");
    const submitBtn = document.getElementById("memo-submit-btn");
    const moreBtn = document.getElementById("memo-load-more-btn");
    const listDiv = document.getElementById("memo-list");

    if (!card || !textarea || !submitBtn || !moreBtn || !listDiv) return;

    // イベント委譲（クリック処理）は一度だけ設定
    if (!memoListInitialized) {
        memoListInitialized = true;

        // 「続きを読む」/「閉じる」と 🗑ボタン の処理
        listDiv.addEventListener("click", async (e) => {
            const target = e.target;

            // 続きを読む／閉じる
            if (target.classList.contains("memo-toggle-btn")) {
                const item = target.closest(".memo-item");
                const body = item.querySelector(".memo-body");
                if (!body) return;
                const expanded = body.classList.toggle("expanded");
                target.textContent = expanded ? "閉じる" : "続きを読む";
                return;
            }

            // 削除
            if (target.classList.contains("memo-delete-btn")) {
                const memoId = target.dataset.id;
                if (!memoId) return;
                if (!confirm("このメモを削除しますか？")) return;

                try {
                    await db.collection("memos").doc(memoId).delete();
                    const item = target.closest(".memo-item");
                    if (item) item.remove();
                } catch (err) {
                    console.error(err);
                    alert("メモの削除に失敗しました。");
                }
            }
        });
    }

    // 投稿ボタン
    submitBtn.addEventListener("click", async () => {
        const text = textarea.value.trim();
        if (!text) {
            alert("メモを入力してください。");
            return;
        }
        if (!currentUser) {
            alert("LINEログイン情報が取得できません。");
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = "送信中...";

        try {
            // members から自分の表示名を取得（なければ LINE 名）
            let authorName = currentUser.displayName || "Unknown";

            const mDoc = await db
                .collection("members")
                .doc(currentUser.lineUserId)
                .get();
            if (mDoc.exists && mDoc.data().name) {
                authorName = mDoc.data().name; // 例: 「渋田 #21号」
            }

            await db.collection("memos").add({
                text,
                authorId: currentUser.lineUserId,
                authorName,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            });

            textarea.value = "";
            memoLastVisible = null; // 最初から読み直し
            await loadMemos(true); // 再読み込み
        } catch (err) {
            console.error(err);
            alert("メモの投稿に失敗しました。");
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "メモを投稿する";
        }
    });

    // もっと見るボタン
    moreBtn.addEventListener("click", async () => {
        await loadMemos(false);
    });

    // 初回ロード
    memoLastVisible = null;
    loadMemos(true);
}

// メモを削除できるかどうか判定
function canDeleteMemo(authorId) {
    if (!currentUser) return false;

    // 管理者は全てのメモを削除可能
    if (ADMIN_IDS.includes(currentUser.lineUserId)) {
        return true;
    }

    // 自分が書いたメモだけ削除可能
    return currentUser.lineUserId === authorId;
}

// ========== みんなのメモ読み込み ==========
async function loadMemos(reset = false) {
    const listDiv = document.getElementById("memo-list");
    const moreBtn = document.getElementById("memo-more-btn");
    if (!listDiv) return;

    if (reset) {
        listDiv.innerHTML = "";
        memoLastVisible = null;
    }

    // members を全部取って { userId: name } マップを作成
    const membersSnap = await db.collection("members").get();
    const memberNameMap = {};
    membersSnap.forEach((mDoc) => {
        const m = mDoc.data();
        memberNameMap[mDoc.id] = (m && m.name) || null; // 「渋田 #21号」など
    });

    // memos を新しい順に 10 件ずつ読み込む
    let query = db.collection("memos").orderBy("createdAt", "desc").limit(10);

    if (memoLastVisible) {
        query = query.startAfter(memoLastVisible);
    }

    const snap = await query.get();
    if (snap.empty) {
        if (reset) {
            listDiv.innerHTML = "<p>まだメモはありません。</p>";
        }
        if (moreBtn) moreBtn.style.display = "none";
        return;
    }

    memoLastVisible = snap.docs[snap.docs.length - 1];

    snap.forEach((doc) => {
        const data = doc.data();

        // 1. members.name を最優先
        // 2. メモ保存時の authorName
        // 3. どちらも無ければ "Unknown"
        const fromMembers = memberNameMap[data.authorId];
        const authorName = fromMembers || data.authorName || "Unknown";

        const item = document.createElement("div");
        item.className = "memo-item";

        const createdAt = data.createdAt
            ? formatDateTime(data.createdAt.toDate())
            : "";

        item.innerHTML = `
          <div class="memo-header">
            <div class="memo-author">${escapeHtml(authorName)}</div>
            <div class="memo-header-right">
              <span class="memo-date">${createdAt}</span>
              ${canDeleteMemo(data.authorId)
                ? '<button class="memo-delete-btn" data-id="' +
                doc.id +
                '">🗑</button>'
                : ""
            }
            </div>
          </div>
          <div class="memo-body">${escapeHtml(data.text || "")}</div>
          <button class="memo-toggle-btn">続きを読む</button>
        `;

        // 「続きを読む」トグル
        const bodyEl = item.querySelector(".memo-body");
        const toggleBtn = item.querySelector(".memo-toggle-btn");
        toggleBtn.addEventListener("click", () => {
            bodyEl.classList.toggle("expanded");
            toggleBtn.textContent = bodyEl.classList.contains("expanded")
                ? "閉じる"
                : "続きを読む";
        });

        // 🗑ボタン（あれば）に削除処理を付与
        const delBtn = item.querySelector(".memo-delete-btn");
        if (delBtn) {
            delBtn.addEventListener("click", async () => {
                if (!confirm("このメモを削除しますか？")) return;
                await db.collection("memos").doc(doc.id).delete();
                await loadMemos(true); // 再読み込み
            });
        }

        listDiv.appendChild(item);
    });

    // 10 件未満なら「もっと見る」を隠す
    if (moreBtn) {
        if (snap.size < 10) {
            moreBtn.style.display = "none";
        } else {
            moreBtn.style.display = "inline-block";
        }
    }
}

// ========== メイン処理 ==========
async function main() {
    console.log("=== main() 開始 ===");
    try {
        db = firebase.firestore();
        console.log("Firestore 初期化 OK");

        await initLiff();
        console.log("LIFF 初期化 OK:", currentUser);

        await ensureMember();
        console.log("ensureMember() OK");

        currentEventId = getEventIdFromUrl();
        console.log("currentEventId =", currentEventId);

        const listView = document.getElementById("event-list-view");
        const detailView = document.getElementById("event-detail-view");

        if (!currentEventId) {
            console.log("一覧モードに入ります");
            listView.style.display = "block";
            detailView.style.display = "none";

            await loadEventList();
            setupMemoSection();
            showStatsPanelIfNeeded();
            showAdminPanelIfNeeded();

            const openMyBtn = document.getElementById("open-my-attendance-btn");
            const myView = document.getElementById("my-attendance-view");

            if (openMyBtn && myView) {
                openMyBtn.addEventListener("click", () => {
                    listView.style.display = "none";
                    myView.style.display = "block";
                    loadMyAttendance();
                });
            }

            const backMyBtn = document.getElementById("back-to-events-btn");
            if (backMyBtn && myView) {
                backMyBtn.addEventListener("click", () => {
                    myView.style.display = "none";
                    listView.style.display = "block";
                });
            }
        } else {
            console.log("詳細モードに入ります");
            listView.style.display = "none";
            detailView.style.display = "block";

            setupBackButton();
            await loadEvent();
            await loadAttendanceList();
            setupButtons();
        }

        console.log("=== main() 正常終了 ===");
    } catch (e) {
        console.error("main() でエラー:", e);
        alert("初期化中にエラーが発生しました。コンソールを確認してください。");
    }
}

// ページロード時に main 実行
window.addEventListener("load", main);

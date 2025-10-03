function TimeCahnge() {
    let now = new Date();
    let timeStr = now.toLocaleTimeString('ja-JP');
    if (P2PSatus) {
        document.getElementById('time-display').innerHTML = '現在時刻: ' + timeStr + "(P2P接続中)";
        document.getElementById('time-display').style.color = "green";
    } else {
        document.getElementById('time-display').innerHTML = '現在時刻: ' + timeStr + "(P2P未接続)";
        document.getElementById('time-display').style.color = "red";
    }
}

document.addEventListener("DOMContentLoaded", async () => { setInterval(TimeCahnge, 1000); });



let P2PURL = "wss://api.p2pquake.net/v2/ws";
let P2PSatus = false;
let P2Psocket;
let P2PList = [];
let reconnectInterval = 3000;


function P2PWebsocket() {
    P2Psocket = new WebSocket(P2PURL);
    P2Psocket.onopen = () => {
        console.log("P2PWebsocket接続成功");
        P2PSatus = true;
    };

    P2Psocket.onmessage = (event) => {
        let data = JSON.parse(event.data);
        let telop = ConvertToTelop(data);
        if (telop) {
            let textarea = document.getElementById('custom-textarea');
            textarea.value = telop + "\n\n" + textarea.value;
        }
    };
    P2Psocket.onerror = (error) => {
        console.error("P2PWebsocketエラー:", error);
        P2PSatus = false;
    };
    P2Psocket.onclose = (event) => {
        console.log("P2PWebsocket接続終了。再接続を試みます...", event.reason);
        P2PSatus = false;
        setTimeout(() => {
            console.log("P2PWebsocket再接続中...");
            P2PWebsocket();
        }, reconnectInterval);
    };
}


function ConvertToTelop(json) {
    const koishiMessages = {
        551: "\n古明地こいし:地震情報が来たよ！\n",
        552: "\n古明地こいし:津波予報が発表されたよ！海の近くの人は気をつけてね！\n",
        5520: "\n古明地こいし:津波情報が解除されたよ！　やったね！\n",
        554: "\n古明地こいし:緊急地震速報を検出したよ！揺れに備えて！\n",
        555: "\n古明地こいし:各地域の接続状況をチェック中だよ～\n",
        556: "\n古明地こいし:緊急地震速報（警報）だよ！強い揺れが来るから身を守って！\n",
        561: "\n古明地こいし:地震を感じた人がいるみたい！情報を集めてるよ！\n",
        9611: "\n古明地こいし:地震感知情報の解析結果が出たよ！\n"
    };

    const message = koishiMessages[json.code];
    if (message) {
        document.getElementById('KoisiText').textContent += message;
        document.getElementById('KoisiText').scrollTop = koisiText.scrollHeight
    }

    if (json.code == 551) {
        return formatJMAQuakeToTelop(json);
    } else if (json.code == 552) {
        return formatJMATsunamisToTelop(json);
    } else if (json.code == 5520) {
        return formatJMATsunamis5520ToTelop(json);
    } else if (json.code == 561) {
        return formatUserquakeToTelop(json);
    } else if (json.code == 555) {
        return formatAreapeersToTelop(json);
    } else if (json.code == 554) {
        return formatEEWDetectionToTelop(json);
    } else if (json.code == 556) {
        return formatEEWToTelop(json);
    } else if (json.code == 9611) {
        return formatUserquakeEvaluationToTelop(json);
    }
}


// codeに対応する列の値を取得する関数
function getValueByCode(data, code, columnName) {
    if (!data) return "データがありません";

    // 空行を除外して2次元配列に変換
    const rows = data
        .split("\n")
        .map(row => row.trim())
        .filter(row => row.length > 0)
        .map(row => row.split(","));

    const headers = rows[0];
    const colIndex = headers.indexOf(columnName);
    if (colIndex === -1) return "カラムが見つからない…";

    for (let i = 1; i < rows.length; i++) {
        if (rows[i][1] === String(code)) {
            return rows[i][colIndex] || "値なし";
        }
    }
    return "該当なし";
}

function getShindoColorByName(shindoName) {
    switch (shindoName) {
        case "震度7": return "#8e44ad";       // 紫 → 高級感あるパープル
        case "震度6強": return "#e74c3c";     // 赤 → ビビッドレッド
        case "震度6弱": return "#e67e22";     // オレンジ → 明るめオレンジ
        case "震度5強": return "#d35400";     // 濃いオレンジ → インパクト大
        case "震度5弱": return "#f1c40f";
        case "震度5弱以上（推定）": return "#5d0606ff"; // 黄色 → キラッと目立つ
        case "震度4": return "#f39c12";       // 明るいオレンジイエロー
        case "震度3": return "#2ecc71";       // 緑 → 爽やかグリーン
        case "震度2": return "#1abc9c";       // シアン系 → ちょっと珍しい緑青色
        case "震度1": return "#3498db";       // 青 → ポップブルー
        default: return "#95a5a6";            // 不明 → グレーで落ち着かせる
    }
}

function formatJMAQuakeToTelop(jmaQuake) {
    const { _id, code, time: receivedTime, issue, earthquake, points, comments } = jmaQuake;

    // --- 発表情報 ---
    const issueSource = issue.source || "不明";
    const issueTime = issue.time || "不明";
    const issueTypeMap = {
        ScalePrompt: "震度速報",
        Destination: "震源に関する情報",
        ScaleAndDestination: "震度・震源に関する情報",
        DetailScale: "各地の震度に関する情報",
        Foreign: "遠地地震に関する情報",
        Other: "その他の情報"
    };
    const issueType = issueTypeMap[issue.type] || "不明";
    const correctMap = {
        None: "なし",
        Unknown: "不明",
        ScaleOnly: "震度訂正",
        DestinationOnly: "震源訂正",
        ScaleAndDestination: "震度・震源訂正"
    };
    const correctText = correctMap[issue.correct] || "不明";

    // --- 地震情報 ---
    const quakeTime = earthquake.time || "不明";
    const hypo = earthquake.hypocenter || {};
    const hypoName = hypo.name || "不明";
    const hypoLat = typeof hypo.latitude === "number" ? (hypo.latitude === -200 ? "不明" : hypo.latitude.toFixed(3)) : "不明";
    const hypoLon = typeof hypo.longitude === "number" ? (hypo.longitude === -200 ? "不明" : hypo.longitude.toFixed(3)) : "不明";
    const hypoDepth = typeof hypo.depth === "number"
        ? (hypo.depth === -1 ? "不明" : (hypo.depth === 0 ? "ごく浅い" : hypo.depth + "km"))
        : "不明";
    const hypoMag = typeof hypo.magnitude === "number"
        ? (hypo.magnitude === -1 ? "不明" : `M${hypo.magnitude.toFixed(1)}`)
        : "不明";

    // --- 最大震度 ---
    const maxScaleMap = {
        "-1": "震度情報なし",
        10: "震度1",
        20: "震度2",
        30: "震度3",
        40: "震度4",
        45: "震度5弱",
        46: "震度5弱以上（推定）",
        50: "震度5強",
        55: "震度6弱",
        60: "震度6強",
        70: "震度7"
    };
    const maxScaleText = maxScaleMap[earthquake.maxScale] || "不明";

    // --- 津波情報 ---
    const tsunamiMap = {
        None: "なし",
        Unknown: "不明",
        Checking: "調査中",
        NonEffective: "若干の海面変動が予想されるが被害の心配なし",
        Watch: "津波注意報",
        Warning: "津波予報（種類不明）",
        NonEffectiveNearby: "震源近傍で小さな津波の可能性あり（被害心配なし）",
        WarningNearby: "震源近傍で津波の可能性あり",
        WarningPacific: "太平洋で津波の可能性あり",
        WarningPacificWide: "太平洋広域で津波の可能性あり",
        WarningIndian: "インド洋で津波の可能性あり",
        WarningIndianWide: "インド洋広域で津波の可能性あり",
        Potential: "一般に津波の可能性あり"
    };
    const domesticTsunamiText = tsunamiMap[earthquake.domesticTsunami] || "不明";
    const foreignTsunamiText = tsunamiMap[earthquake.foreignTsunami] || "不明";

    // --- 震度観測点 ---
    const scaleMap = {
        10: "震度1",
        20: "震度2",
        30: "震度3",
        40: "震度4",
        45: "震度5弱",
        46: "震度5弱以上（推定）",
        50: "震度5強",
        55: "震度6弱",
        60: "震度6強",
        70: "震度7"
    };

    // 震度観測点全部を「都道府県 住所 震度」の形で並べる（規模問わず）
    const pointsText = points.length > 0
        ? points.map(p => `${p.pref} ${p.addr} ${scaleMap[p.scale] || p.scale}`).join("、")
        : "震度観測点なし";

    // --- コメント（自由付加文） ---
    const freeComment = comments.freeFormComment ? comments.freeFormComment.trim() : "";

    // --- テロップ文章組み立て ---

    const telop =
        `ID: ${_id}受信日時: ${receivedTime}

【発表情報】
発表元: ${issueSource}
発表日時: ${issueTime}
発表種類: ${issueType}
訂正の有無: ${correctText}

【地震発生情報】
発生日時: ${quakeTime}
震源名称: ${hypoName}
緯度: ${hypoLat}
経度: ${hypoLon}
深さ: ${hypoDepth}
マグニチュード: ${hypoMag}
最大震度: ${maxScaleText}

【津波情報】
国内: ${domesticTsunamiText}
海外: ${foreignTsunamiText}

【震度観測点】
${pointsText}

${freeComment ? `【備考】
${freeComment}` : ''}`;

    return telop;
}

function formatJMATsunamisToTelop(jmaTsunamis) {
    const { _id, code, time: receivedTime, cancelled, issue, areas } = jmaTsunamis;

    // --- 発表情報 ---
    const issueSource = issue.source || "不明";
    const issueTime = issue.time || "不明";
    const issueType = issue.type || "不明";

    // --- 津波予報解除 ---
    if (cancelled) {
        return `【津波予報解除】
ID: ${_id}
情報コード: ${code}
受信日時: ${receivedTime}

発表元: ${issueSource}
発表日時: ${issueTime}
発表種類: ${issueType}

現在、津波予報は解除されています。`;
    }

    // --- 津波予報区情報 ---
    const gradeMap = {
        MajorWarning: "大津波警報",
        Warning: "津波警報",
        Watch: "津波注意報",
        Unknown: "不明"
    };

    // firstHeight.conditionのEnumは3種類。具体的な値が不明なのでそのまま表示。

    // areasが空なら「津波予報なし」
    if (!areas || areas.length === 0) {
        return `【津波予報】
ID: ${_id}
情報コード: ${code}
受信日時: ${receivedTime}

発表元: ${issueSource}
発表日時: ${issueTime}
発表種類: ${issueType}

津波予報区の情報はありません。`;
    }
    const TSUNAMIAREALIST = [];
    // 各津波予報区を文章化
    const areasText = areas.map(area => {
        const gradeText = gradeMap[area.grade] || area.grade || "不明";
        const immedText = area.immediate ? "直ちに津波が来襲すると予想されています。" : "直ちに津波が来襲する予想はありません。";
        const name = area.name || "不明";


        // 到達予想時刻
        const arrivalTime = area.firstHeight?.arrivalTime || "不明";
        const condition = area.firstHeight?.condition || "不明";

        // 津波の高さ
        const maxHeightDesc = area.maxHeight?.description || "不明";
        const maxHeightValue = (typeof area.maxHeight?.value === "number") ? area.maxHeight.value : null;



        const heightText = maxHeightValue !== null
            ? `${maxHeightDesc}（約${maxHeightValue}m）`
            : maxHeightDesc;

        return `・${name}：${gradeText}
  ${immedText}
  第1波到達予想時刻：${arrivalTime}
  津波の高さ予想：${heightText}`;
    }).join("\n\n");

    // --- テロップ組み立て ---
    const telop =
        `【津波予報】
ID: ${_id}
情報コード: ${code}
受信日時: ${receivedTime}

発表元: ${issueSource}
発表日時: ${issueTime}
発表種類: ${issueType}

${areasText}`;

    return telop;
}

function formatJMATsunamis5520ToTelop(jmaTsunamis) {
    const { _id, code, time: receivedTime, cancelled, issue, areas } = jmaTsunamis;

    // --- 発表情報 ---
    const issueSource = issue.source || "不明";
    const issueTime = issue.time || "不明";
    const issueType = issue.type || "不明";

    // --- 津波予報解除 ---
    if (cancelled) {
        return `【津波予報解除】 (5520)
ID: ${_id}
情報コード: ${code}
受信日時: ${receivedTime}

発表元: ${issueSource}
発表日時: ${issueTime}
発表種類: ${issueType}

現在、津波予報は解除されています。`;
    }

    // --- 津波注意報レベル変換 ---
    const gradeMap = {
        MajorWarning: "大津波警報",
        Warning: "津波警報",
        Watch: "津波注意報",
        Unknown: "不明"
    };

    if (!areas || areas.length === 0) {
        return `【津波予報】 (5520)
ID: ${_id}
情報コード: ${code}
受信日時: ${receivedTime}

発表元: ${issueSource}
発表日時: ${issueTime}
発表種類: ${issueType}

津波予報区の情報はありません。`;
    }
    // --- 各地域の文章化 ---
    const areasText = areas.map(area => {
        const gradeText = gradeMap[area.grade] || area.grade || "不明";
        const immedText = area.immediate ? "直ちに津波が来襲すると予想されています。" : "直ちに津波が来襲する予想はありません。";
        const name = area.name || "不明";


        return `・${name}：${gradeText}
  ${immedText}`;
    }).join("\n\n");

    // --- テロップ組み立て ---
    const telop =
        `【津波予報
ID: ${_id}
情報コード: ${code}
受信日時: ${receivedTime}

発表元: ${issueSource}
発表日時: ${issueTime}
発表種類: ${issueType}

${areasText}`;

    return telop;
}

function formatUserquakeToTelop(userquake) {
    const { _id, code, time: receivedTime, area } = userquake;


    if (isFinite(lng) && isFinite(lat)) {
        // lng, lat の順番で渡す
    }

    return (
        `【地震感知情報】\n` +
        `ID: ${_id}\n` +
        `情報コード: ${code}\n` +
        `受信日時: ${receivedTime}\n` +
        `地域: ${area}`
    );
}


function formatAreapeersToTelop(areapeers) {
    const { _id, code, time: receivedTime, areas } = areapeers;

    if (!areas || areas.length === 0) {
        return (
            `【P2P地震情報ネットワーク ピア地域分布】
ID: ${_id}
情報コード: ${code}
受信日時: ${receivedTime}

ピアの地域分布情報はありません。`
        );
    }


    const areasText = areas.map(area => `${area.id}: ピア数 ${area.peer}\n`);
    // ここでまとめて呼び出す

    const telop =
        `【P2P地震情報ネットワーク ピア地域分布】
ID: ${_id}
情報コード: ${code}
受信日時: ${receivedTime}

地域ごとのピア数:
${areasText}`;

    return telop;
}

function formatEEWDetectionToTelop(eewDetection) {
    const { _id, code, time: receivedTime, type } = eewDetection;

    return (
        `【緊急地震速報 発表検出】
ID: ${_id}
情報コード: ${code}
受信日時: ${receivedTime}
検出種類: ${type || "不明"}`
    );
}

function formatEEWToTelop(eew) {
    const {
        _id,
        code,
        time: receivedTime,
        test,
        earthquake,
        issue,
        cancelled,
        areas
    } = eew;

    // 取消時のメッセージ
    if (cancelled) {
        return (
            `【緊急地震速報 取消】
ID: ${_id}
情報コード: ${code}
受信日時: ${receivedTime}

この速報は取消されました。`
        );
    }

    // 地震情報
    const eq = earthquake || {};
    const hypocenter = eq.hypocenter || {};

    // 震源情報
    const hypocenterName = hypocenter.name || "不明";
    const reduceName = hypocenter.reduceName || "";
    const latitude = hypocenter.latitude ?? -200;
    const longitude = hypocenter.longitude ?? -200;
    const depth = Math.floor(hypocenter.depth ?? -1);
    const magnitude = hypocenter.magnitude ?? -1;

    // 発表情報
    const issueTime = issue?.time || "不明";
    const eventId = issue?.eventId || "不明";
    const serial = issue?.serial || "不明";

    // 震度の数字 → 表示文字マップ
    const scaleMap = {
        [-1]: "不明",
        0: "震度0",
        10: "震度1",
        20: "震度2",
        30: "震度3",
        40: "震度4",
        45: "震度5弱",
        50: "震度5強",
        55: "震度6弱",
        60: "震度6強",
        70: "震度7",
        99: "～程度以上"
    };

    const P2PEEWList = [];
    // areasが空なら「予測震度情報なし」
    const areasText = (areas && areas.length > 0)
        ? areas.map(area => {
            const pref = area.pref || "不明";
            const name = area.name || "不明";
            const scaleFrom = Math.floor(area.scaleFrom ?? -1);
            const scaleTo = Math.floor(area.scaleTo ?? -1);
            const kindCode = area.kindCode || "不明";
            const arrivalTime = area.arrivalTime || "不明";

            const fromText = scaleMap[scaleFrom] || scaleFrom;
            const toText = scaleMap[scaleTo] || scaleTo;
            P2PEEWList.push([name, scaleMap[scaleTo]])
            // kindCodeの説明
            const kindCodeMap = {
                10: "主要動について未到達と予測",
                11: "主要動について既に到達と予測",
                19: "主要動の到達予想なし（PLUM法による予想）"
            };
            const kindDesc = kindCodeMap[kindCode] || kindCode;

            return `・${pref} ${name}：予測震度 ${fromText}～${toText}
  警報コード: ${kindDesc}
  主要動到達予測時刻: ${arrivalTime}`;
        }).join("\n\n")
        : "予測震度情報はありません。";
    return (
        `【緊急地震速報】
ID: ${_id}
情報コード: ${code}
受信日時: ${receivedTime}
テスト速報: ${test ? "はい" : "いいえ"}

【地震情報】
発生時刻: ${eq.originTime || "不明"}
地震発現時刻: ${eq.arrivalTime || "不明"}
震央: ${hypocenterName} (${reduceName})
緯度: ${latitude}, 経度: ${longitude}
深さ: ${depth}km
マグニチュード: ${magnitude}

【発表情報】
発表時刻: ${issueTime}
イベントID: ${eventId}
情報番号: ${serial}

【細分区域の震度予測】
${areasText}`
    );
}

function formatUserquakeEvaluationToTelop(evaluation) {
    const {
        _id,
        code,
        time: evalTime,
        count,
        confidence,
        started_at,
        updated_at,
        area_confidences
    } = evaluation;

    // 信頼度レベルを数値で判断して表示テキスト作成
    let confidenceLevel = "不明";
    if (confidence === 0) confidenceLevel = "非表示";
    else if (Math.abs(confidence - 0.97015) < 0.0001) confidenceLevel = "レベル1";
    else if (Math.abs(confidence - 0.96774) < 0.0001) confidenceLevel = "レベル2";
    else if (Math.abs(confidence - 0.97024) < 0.0001) confidenceLevel = "レベル3";
    else if (Math.abs(confidence - 0.98052) < 0.0001) confidenceLevel = "レベル4";
    else confidenceLevel = confidence.toFixed(4);

    // 地域ごとの信頼度レベル判定
    function getAreaGrade(conf) {
        if (conf < 0) return "F";
        if (conf < 0.2) return "E";
        if (conf < 0.4) return "D";
        if (conf < 0.6) return "C";
        if (conf < 0.8) return "B";
        return "A";
    }

    // 地域ごとの情報整形
    const areasText = (area_confidences && Object.keys(area_confidences).length > 0)
        ? Object.entries(area_confidences).map(([areaCode, data]) => {
            const grade = getAreaGrade(data.confidence);
            return `${areaCode}：
  信頼度: ${data.confidence.toFixed(4)} (${grade})
  件数: ${data.count}
  表示: ${data.display || "なし"}`;
        }).join("\n\n")
        : "地域別信頼度情報はありません。";

    return (
        `【地震感知情報評価結果】
ID: ${_id}
情報コード: ${code}
評価日時: ${evalTime}
検知件数: ${count}
全体信頼度: ${confidence.toFixed(5)} (${confidenceLevel})
イベント開始: ${started_at}
更新日時: ${updated_at}

【地域ごとの信頼度】
${areasText}`
    );
}

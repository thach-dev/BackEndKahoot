
import { io } from "socket.io-client";

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  "https://backendkahoot.onrender.com";

let socket = null;

export function getRoomSocket() {
  if (!socket) {
    socket = io(SOCKET_URL, {
      autoConnect: false,
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      timeout: 20000,
    });
  }

  return socket;
}

/**
 * Gửi sự kiện Socket.IO và chờ callback từ backend.
 * Backend quizSocket.js dùng callback({ ok, ... }) nên không cần
 * chờ một event thành công riêng.
 */
function emitWithAck(eventName, payload, timeoutMs = 25000) {
  const client = getRoomSocket();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);

      client.off("connect_error", onConnectError);
      client.off("connect", onConnect);
    };

    const finish = (callback, value) => {
      if (settled) return;

      settled = true;
      cleanup();
      callback(value);
    };

    const onConnectError = (error) => {
      finish(
        reject,
        new Error(
          `Không kết nối được máy chủ: ${
            error?.message || "Lỗi kết nối"
          }`
        )
      );
    };

    const send = () => {
      if (settled) return;

      client.emit(eventName, payload, (response) => {
        if (settled) return;

        if (!response) {
          finish(
            reject,
            new Error("Máy chủ không trả dữ liệu phản hồi.")
          );
          return;
        }

        if (response.ok !== true) {
          finish(
            reject,
            new Error(response.message || "Thao tác thất bại.")
          );
          return;
        }

        finish(resolve, response);
      });
    };

    const onConnect = () => {
      send();
    };

    timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          `Hết thời gian chờ phản hồi từ máy chủ (${eventName}).`
        )
      );
    }, timeoutMs);

    client.on("connect_error", onConnectError);

    if (client.connected) {
      send();
    } else {
      client.once("connect", onConnect);

      if (!client.active) {
        client.connect();
      }
    }
  });
}

/**
 * Tạo phòng từ quiz đã lưu trong database.
 * Yêu cầu backend xác thực socket và có socket.data.userId.
 */
export async function createRoom(quizId) {
  if (!quizId) {
    throw new Error("Không tìm thấy quizId.");
  }

  return emitWithAck("host:create", { quizId });
}

/**
 * Tạo phòng trực tiếp từ danh sách câu hỏi.
 * Mỗi câu hỏi cần question_text/question, answers/options (4 đáp án),
 * correct_answer/correctAnswer (0-3 hoặc A-D).
 */
export async function createRoomWithQuestions(
  questions,
  title = "Quiz Multiplayer"
) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("Quiz cần có ít nhất một câu hỏi.");
  }

  return emitWithAck("host:create", {
    questions,
    title,
  });
}

/**
 * Người chơi tham gia phòng.
 * Backend nhận đúng trường nickname, không phải playerName.
 */
export async function joinRoom(pin, nickname) {
  const cleanPin = String(pin ?? "").trim();
  const cleanNickname = String(nickname ?? "").trim();

  if (!/^\d{6}$/.test(cleanPin)) {
    throw new Error("PIN phòng phải gồm đúng 6 chữ số.");
  }

  if (!cleanNickname) {
    throw new Error("Vui lòng nhập nickname.");
  }

  return emitWithAck("player:join", {
    pin: cleanPin,
    nickname: cleanNickname,
  });
}

export async function startRoom(pin) {
  return emitWithAck("host:start", { pin });
}

export async function revealAnswer(pin) {
  return emitWithAck("host:reveal-answer", { pin });
}

export async function nextQuestion(pin) {
  return emitWithAck("host:next-question", { pin });
}

export async function closeRoom(pin) {
  return emitWithAck("host:close", { pin });
}

/**
 * Chỉ ngắt kết nối khi thực sự rời khỏi phiên chơi.
 */
export function disconnectRoomSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

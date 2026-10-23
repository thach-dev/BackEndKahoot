
const { supabase } = require("../config/supabase");

async function getQuizForHost(quizId, ownerId) {
  if (!quizId) {
    throw new Error("Thiếu mã bài quiz.");
  }

  // 1. Lấy quiz theo ID, không giới hạn người sở hữu
  const { data: quiz, error: quizError } = await supabase
    .from("quiz_games")
    .select("id, owner_id, title, created_at")
    .eq("id", quizId)
    .maybeSingle();

  if (quizError) {
    console.error("GET QUIZ ERROR:", quizError);
    throw new Error(`Lỗi truy vấn quiz: ${quizError.message}`);
  }

  if (!quiz) {
    throw new Error("Không tìm thấy bài quiz.");
  }

  // 2. Lấy câu hỏi theo ID của quiz
  const { data: questions, error: questionsError } = await supabase
    .from("quiz_questions")
    .select(
      "id, game_id, question_text, answers, correct_answer, time_limit, points, question_order"
    )
    .eq("game_id", quizId)
    .order("question_order", { ascending: true });

  if (questionsError) {
    console.error("GET QUESTIONS ERROR:", questionsError);
    throw new Error(
      `Không thể lấy câu hỏi: ${questionsError.message}`
    );
  }

  if (!questions || questions.length === 0) {
    throw new Error("Bài quiz này chưa có câu hỏi.");
  }

  // 3. Chuẩn hóa dữ liệu cho Socket.IO
  return {
    ...quiz,
    questions: questions.map((q) => ({
      ...q,
      question_text: q.question_text,
      answers: q.answers,
      correct_answer: q.correct_answer,
      time_limit: q.time_limit ?? 20,
      points: q.points ?? 1000,
    })),
  };
}

module.exports = {
  getQuizForHost,
};

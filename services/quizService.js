const { supabase } = require("../config/supabase");

async function getQuizForHost(quizId, ownerId) {
  if (!quizId) {
    throw new Error("Thiếu mã bài quiz.");
  }

  // 1. Lấy thông tin quiz và câu hỏi trực tiếp từ quiz_games
  const { data: quiz, error: quizError } = await supabase
    .from("quiz_games")
    .select("id, owner_id, title, created_at, questions")
    .eq("id", quizId)
    .maybeSingle();

  if (quizError) {
    console.error("GET QUIZ ERROR:", quizError);
    throw new Error(`Lỗi truy vấn quiz: ${quizError.message}`);
  }

  if (!quiz) {
    throw new Error("Không tìm thấy bài quiz.");
  }

  // 2. Kiểm tra dữ liệu JSONB
  if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    throw new Error("Bài quiz này chưa có câu hỏi trong quiz_games.");
  }

  // 3. Chuẩn hóa câu hỏi
  const questions = quiz.questions
    .map((q, index) => ({
      ...q,
      question_text: q.question_text ?? "",
      answers: Array.isArray(q.answers) ? q.answers : [],
      correct_answer: q.correct_answer,
      time_limit: q.time_limit ?? 20,
      points: q.points ?? 1000,
      question_order: q.question_order ?? index + 1,
    }))
    .sort((a, b) => a.question_order - b.question_order);

  // 4. Trả dữ liệu cho host / Socket.IO
  return {
    id: quiz.id,
    owner_id: quiz.owner_id,
    title: quiz.title,
    created_at: quiz.created_at,
    questions,
  };
}

module.exports = {
  getQuizForHost,
};
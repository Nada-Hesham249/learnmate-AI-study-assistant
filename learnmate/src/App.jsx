import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

const menuItems = [
  { id: "dashboard", label: "Dashboard", icon: "⌂" },
  { id: "tutor", label: "Study Companion", icon: "✳" },
  { id: "quizzes", label: "Quizzes", icon: "▤" },
  { id: "progress", label: "My Progress", icon: "↗" },
];

// Requests go to the Vite dev server, which proxies them to the Kaggle API
// (LEARNMATE_API_URL) and adds the X-API-Key header (see vite.config.js).
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api").replace(
  /\/+$/,
  ""
);

const BACKEND_OFFLINE =
  "Cannot reach the LearnMate AI backend. Make sure the Kaggle notebook is running " +
  "(API cell started) and that LEARNMATE_API_URL in learnmate/.env.local matches the " +
  "ngrok URL it printed, then restart npm run dev.";

function formatDetail(detail) {
  if (typeof detail === "string") return detail;

  if (Array.isArray(detail)) {
    return detail
      .map((item) => `${item.loc?.slice(-1)[0] ?? "request"}: ${item.msg}`)
      .join("; ");
  }

  return "";
}

async function apiRequest(path, { timeoutMs = 300000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      error.name === "AbortError"
        ? "The AI backend took too long to respond. Please try again."
        : BACKEND_OFFLINE,
      { cause: error }
    );
  } finally {
    clearTimeout(timer);
  }

  const isJson = (response.headers.get("content-type") || "").includes(
    "application/json"
  );
  const data = isJson ? await response.json().catch(() => null) : null;

  // An HTML page or empty body means ngrok/Kaggle is offline, not our API.
  if (!data) {
    const error = new Error(BACKEND_OFFLINE);
    error.status = response.status;
    throw error;
  }

  if (!response.ok) {
    const message =
      response.status === 401
        ? "The AI backend rejected the API key. Make sure LEARNMATE_API_KEY in " +
          "learnmate/.env.local matches the Kaggle notebook, then restart npm run dev."
        : formatDetail(data.detail) ||
          `Request failed (HTTP ${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return data;
}

// Quiz results are kept in this browser only (localStorage), newest first.
const PROGRESS_STORAGE_KEY = "learnmate.quizResults.v1";
const MAX_STORED_RESULTS = 200;

function isValidResult(result) {
  return (
    result != null &&
    typeof result.id === "string" &&
    Number.isInteger(result.correct) &&
    Number.isInteger(result.total) &&
    result.total > 0 &&
    result.correct >= 0 &&
    result.correct <= result.total &&
    !Number.isNaN(Date.parse(result.completedAt))
  );
}

function loadQuizResults() {
  try {
    const stored = JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter(isValidResult) : [];
  } catch {
    return [];
  }
}

function saveQuizResults(results) {
  try {
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(results));
    return true;
  } catch {
    return false;
  }
}

function createAttemptId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function percentOf(correct, total) {
  return total > 0 ? Math.round((correct / total) * 100) : 0;
}

function summarizeResults(results) {
  if (results.length === 0) return null;

  const lectures = new Map();

  for (const result of results) {
    const name = result.lectureName || "Unnamed lecture";
    const lecture = lectures.get(name) || { name, quizzes: 0, correct: 0, total: 0 };
    lecture.quizzes += 1;
    lecture.correct += result.correct;
    lecture.total += result.total;
    lectures.set(name, lecture);
  }

  return {
    completed: results.length,
    // Mean of each quiz's percentage, so every quiz counts equally.
    averagePercent: Math.round(
      (results.reduce((sum, r) => sum + r.correct / r.total, 0) / results.length) * 100
    ),
    bestPercent: Math.max(...results.map((r) => percentOf(r.correct, r.total))),
    totalCorrect: results.reduce((sum, r) => sum + r.correct, 0),
    totalQuestions: results.reduce((sum, r) => sum + r.total, 0),
    // Weakest lectures first, to show what to revise.
    lectures: [...lectures.values()]
      .map((lecture) => ({ ...lecture, percent: percentOf(lecture.correct, lecture.total) }))
      .sort((a, b) => a.percent - b.percent),
  };
}

function formatDate(isoDate) {
  return new Date(isoDate).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function App() {
  const [activePage, setActivePage] = useState("dashboard");
  const [apiStatus, setApiStatus] = useState("checking");
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileError, setFileError] = useState("");
  const [uploadResult, setUploadResult] = useState(null);
  const [documentId, setDocumentId] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatError, setChatError] = useState("");
  const [isChatting, setIsChatting] = useState(false);
  const [quizCount, setQuizCount] = useState(5);
  const [quizTopic, setQuizTopic] = useState("");
  const [quiz, setQuiz] = useState(null);
  const [quizAnswers, setQuizAnswers] = useState({});
  const [quizChecked, setQuizChecked] = useState(false);
  const [quizError, setQuizError] = useState("");
  const [isGeneratingQuiz, setIsGeneratingQuiz] = useState(false);
  const [quizResults, setQuizResults] = useState(loadQuizResults);
  const [progressError, setProgressError] = useState("");
  const fileInputRef = useRef(null);

  const checkBackend = useCallback(async () => {
    setApiStatus("checking");

    try {
      const data = await apiRequest("/health", { timeoutMs: 15000 });
      setApiStatus(data.model_loaded === false ? "offline" : "online");
    } catch {
      setApiStatus("offline");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time health check on load
    checkBackend();
  }, [checkBackend]);

  function resetLecture() {
    setUploadResult(null);
    setDocumentId("");
    setChatMessages([]);
    setQuiz(null);
    setQuizAnswers({});
    setQuizChecked(false);
  }

  // Called when the backend no longer knows the lecture (e.g. Kaggle restarted).
  function handleLectureLost(error) {
    if (error.status === 404) {
      resetLecture();
      setSelectedFile(null);
    }
  }

  async function handleFileChange(event) {
    const file = event.target.files?.[0];

    setFileError("");
    resetLecture();

    if (!file) return;

    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      setFileError("Please select a PDF file.");
      event.target.value = "";
      return;
    }

    if (file.size > 20 * 1024 * 1024) {
      setFileError("The file must not exceed 20 MB.");
      event.target.value = "";
      return;
    }

    setSelectedFile(file);
    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const data = await apiRequest("/upload", {
        method: "POST",
        body: formData,
      });

      if (!data.document_id) {
        throw new Error("The backend did not return a document ID.");
      }

      setUploadResult(data);
      setDocumentId(data.document_id);
      setApiStatus("online");
    } catch (error) {
      setFileError(error.message);
    } finally {
      setIsUploading(false);
    }
  }

  function removeFile() {
    setSelectedFile(null);
    setFileError("");
    resetLecture();

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleChatSubmit(event) {
    event.preventDefault();

    const message = chatInput.trim();
    if (!message || isChatting) return;

    setChatError("");
    setChatInput("");
    setChatMessages((previousMessages) => [
      ...previousMessages,
      { role: "user", content: message },
    ]);
    setIsChatting(true);

    try {
      // With a lecture: grounded RAG answer. Without one: general answer, labelled as such.
      const data = documentId
        ? await apiRequest("/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ document_id: documentId, question: message }),
          })
        : await apiRequest("/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt:
                "You are LearnMate, a friendly AI tutor. Answer the student's " +
                "question clearly and concisely. If you are unsure, say so.\n\n" +
                `Question: ${message}`,
              max_new_tokens: 400,
            }),
          });

      if (!data.answer) {
        throw new Error("The AI service returned an empty answer.");
      }

      const sourcePages = data.cited_pages?.length
        ? data.cited_pages
        : (data.sources || []).map((source) => source.page);

      setChatMessages((previousMessages) => [
        ...previousMessages,
        {
          role: "assistant",
          content: data.answer,
          pages: sourcePages.filter((page) => page != null),
          confidence: data.confidence,
          general: !documentId,
        },
      ]);
    } catch (error) {
      setChatError(error.message);
      handleLectureLost(error);
    } finally {
      setIsChatting(false);
    }
  }

  async function handleGenerateQuiz(event) {
    event.preventDefault();
    if (!documentId || isGeneratingQuiz) return;

    setQuizError("");
    setQuiz(null);
    setQuizAnswers({});
    setQuizChecked(false);
    setIsGeneratingQuiz(true);

    try {
      const data = await apiRequest("/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_id: documentId,
          num_questions: Number(quizCount),
          topic: quizTopic.trim() || null,
        }),
        timeoutMs: 600000,
      });

      if (!Array.isArray(data.questions) || data.questions.length === 0) {
        throw new Error("The AI returned no valid quiz questions.");
      }

      setQuiz({ ...data, attemptId: createAttemptId() });
    } catch (error) {
      setQuizError(error.message);
      handleLectureLost(error);
    } finally {
      setIsGeneratingQuiz(false);
    }
  }

  // Saves a completed quiz once; repeated calls for the same attempt are ignored.
  function recordQuizResult(completedQuiz, correct) {
    const stored = loadQuizResults();

    if (stored.some((result) => result.id === completedQuiz.attemptId)) {
      setQuizResults(stored);
      return;
    }

    const next = [
      {
        id: completedQuiz.attemptId,
        completedAt: new Date().toISOString(),
        lectureName: uploadResult?.filename || "",
        topic: completedQuiz.topic || "",
        correct,
        total: completedQuiz.questions.length,
      },
      ...stored,
    ].slice(0, MAX_STORED_RESULTS);

    setQuizResults(next);
    setProgressError(
      saveQuizResults(next)
        ? ""
        : "Your browser blocked saving progress, so this result will be lost on reload."
    );
  }

  function handleCheckAnswers() {
    if (!quiz || quizChecked) return;

    const correct = quiz.questions.filter(
      (question, index) => quizAnswers[index] === question.correct_index
    ).length;

    setQuizChecked(true);
    recordQuizResult(quiz, correct);
  }

  function clearProgress() {
    if (!window.confirm("Delete all saved quiz results from this browser?")) return;

    try {
      localStorage.removeItem(PROGRESS_STORAGE_KEY);
    } catch {
      // Storage is blocked; clearing the in-memory list is all we can do.
    }

    setQuizResults([]);
    setProgressError("");
  }

  const progressSummary = summarizeResults(quizResults);

  const quizScore = quiz
    ? quiz.questions.filter(
        (question, index) => quizAnswers[index] === question.correct_index
      ).length
    : 0;

  const statusLabel = {
    checking: "Connecting to AI...",
    online: "AI Study Assistant · online",
    offline: "AI Study Assistant · offline",
  }[apiStatus];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">L</div>
          <div>
            <h2>LearnMate</h2>
            <p>Your AI study companion</p>
          </div>
        </div>

        <p className="menu-label">MENU</p>

        <nav>
          {menuItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${
                activePage === item.id ? "active" : ""
              }`}
              onClick={() => setActivePage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="avatar">S</div>
          <div>
            <strong>Student</strong>
            <p>Keep learning!</p>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <span>My Learning Space</span>
          <button
            type="button"
            className="status"
            onClick={checkBackend}
            title={
              apiStatus === "offline"
                ? "Backend unreachable. Click to check again."
                : "Click to check the AI backend again."
            }
          >
            <span className={`status-dot ${apiStatus}`} />
            {statusLabel}
          </button>
        </header>

        <section className="welcome">
          <p className="eyebrow">YOUR PERSONAL STUDY SPACE</p>
          <h1>
            {activePage === "dashboard"
              ? "Learn something new today."
              : menuItems.find((item) => item.id === activePage)?.label}
          </h1>
          <p className="welcome-text">
            Your lectures, your AI study companion, and your learning
            progress — all in one place.
          </p>
        </section>

        {activePage === "dashboard" ? (
          <>
            <section className="upload-card">
              <div className="upload-icon">↑</div>
              <h2>Start with your lecture</h2>
              <p>
                Upload a PDF lecture to start asking questions and
                creating personalized quizzes.
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                hidden
                onChange={handleFileChange}
              />

              <button
                type="button"
                className="primary-button"
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {isUploading ? "Processing PDF..." : "Upload a lecture"}
                <span>＋</span>
              </button>

              <small>PDF files · Maximum size: 20 MB</small>

              {fileError && (
                <p className="file-error" role="alert">
                  {fileError}
                </p>
              )}

              {selectedFile && (
                <div className="selected-file">
                  <div className="file-info">
                    <div className="file-icon">PDF</div>
                    <div className="file-details">
                      <strong>{selectedFile.name}</strong>
                      <p>
                        {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                      </p>
                    </div>
                  </div>

                  <button
                    className="secondary-button"
                    type="button"
                    onClick={removeFile}
                    disabled={isUploading}
                  >
                    Remove file
                  </button>
                </div>
              )}

              {isUploading && (
                <p role="status">
                  Uploading, extracting text and indexing the lecture...
                </p>
              )}

              {uploadResult && (
                <div className="upload-success" role="status">
                  <h3>Lecture uploaded successfully!</h3>
                </div>
              )}
            </section>

            <section className="section">
              <div className="section-heading">
                <div>
                  <h2>Your study tools</h2>
                  <p>Choose how you want to learn.</p>
                </div>
              </div>

              <div className="feature-grid">
                <button
                  className="feature-card"
                  onClick={() => setActivePage("tutor")}
                >
                  <div className="feature-icon purple">✳</div>
                  <h3>Study Companion</h3>
                  <p>Ask questions and understand difficult topics.</p>
                  <span className="card-link">Start learning ↗</span>
                </button>

                <button
                  className="feature-card"
                  onClick={() => setActivePage("quizzes")}
                >
                  <div className="feature-icon peach">▤</div>
                  <h3>Practice Quizzes</h3>
                  <p>Test your knowledge with AI-generated questions.</p>
                  <span className="card-link">Practice now ↗</span>
                </button>

                <button
                  className="feature-card"
                  onClick={() => setActivePage("progress")}
                >
                  <div className="feature-icon green">↗</div>
                  <h3>My Progress</h3>
                  <p>Review your performance and topics to improve.</p>
                  <span className="card-link">View progress ↗</span>
                </button>
              </div>
            </section>
          </>
        ) : activePage === "tutor" ? (
          <section className="chat-card">
            <div className="feature-icon purple">✳</div>
            <h2>Study Companion</h2>
            <p>
              Ask questions about your uploaded lecture or any topic you are
              learning.
            </p>

            <p className="context-status" role="status">
              {documentId
                ? `Answering from your lecture: ${uploadResult?.filename || "uploaded PDF"}`
                : "No lecture uploaded — answers will be general, not from your lecture."}
            </p>

            <div className="chat-messages" aria-live="polite">
              {chatMessages.length === 0 && (
                <p className="chat-empty">
                  Your questions and LearnMate&apos;s answers will appear here.
                </p>
              )}
              {chatMessages.map((chatMessage, index) => (
                <div
                  className={`chat-message ${chatMessage.role}`}
                  key={`${chatMessage.role}-${index}`}
                >
                  <strong>
                    {chatMessage.role === "user" ? "You" : "LearnMate"}
                  </strong>
                  <p>{chatMessage.content}</p>
                  {chatMessage.pages?.length > 0 && (
                    <small className="chat-sources">
                      Sources: {chatMessage.pages.map((page) => `Page ${page}`).join(", ")}
                    </small>
                  )}
                  {chatMessage.confidence === "low" && (
                    <small className="chat-note">
                      Weak match in the lecture — double-check with your notes.
                    </small>
                  )}
                  {chatMessage.general && (
                    <small className="chat-note">
                      General answer — not based on an uploaded lecture.
                    </small>
                  )}
                </div>
              ))}
              {isChatting && (
                <p className="chat-loading" role="status">
                  LearnMate is thinking...
                </p>
              )}
            </div>

            {chatError && (
              <p className="file-error" role="alert">
                {chatError}
              </p>
            )}

            <form className="chat-form" onSubmit={handleChatSubmit}>
              <input
                type="text"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="Ask a question..."
                aria-label="Ask LearnMate a question"
                maxLength={4000}
                disabled={isChatting}
              />
              <button
                className="primary-button"
                type="submit"
                disabled={isChatting || !chatInput.trim()}
              >
                {isChatting ? "Sending..." : "Send"}
              </button>
            </form>

            <button
              className="secondary-button"
              onClick={() => setActivePage("dashboard")}
            >
              Back to Dashboard
            </button>
          </section>
        ) : activePage === "quizzes" ? (
          <section className="study-material-card">
            <div className="feature-icon peach">▤</div>
            <h2>Practice Quiz</h2>
            <p>
              Generate multiple-choice questions from your uploaded lecture,
              answer them, then check your score.
            </p>

            {!documentId && (
              <p className="file-error" role="alert">
                Upload a lecture from the Dashboard before generating a quiz.
              </p>
            )}

            <form className="quiz-form" onSubmit={handleGenerateQuiz}>
              <select
                value={quizCount}
                onChange={(event) => setQuizCount(event.target.value)}
                aria-label="Number of questions"
                disabled={isGeneratingQuiz}
              >
                {[3, 5, 8, 10].map((count) => (
                  <option key={count} value={count}>
                    {count} questions
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={quizTopic}
                onChange={(event) => setQuizTopic(event.target.value)}
                placeholder="Optional topic (empty = whole lecture)"
                aria-label="Quiz topic"
                maxLength={200}
                disabled={isGeneratingQuiz}
              />
              <button
                className="primary-button"
                type="submit"
                disabled={!documentId || isGeneratingQuiz}
              >
                {isGeneratingQuiz ? "Generating quiz..." : "Generate quiz"}
              </button>
            </form>

            {isGeneratingQuiz && (
              <p role="status">
                Writing questions from your lecture. This can take a minute.
              </p>
            )}

            {quizError && (
              <p className="file-error" role="alert">
                {quizError}
              </p>
            )}

            {quiz && (
              <>
                <div className="study-items" aria-live="polite">
                  {quiz.questions.map((question, questionIndex) => (
                    <article
                      className="study-item"
                      key={`${question.question}-${questionIndex}`}
                    >
                      <span className="item-number">
                        Question {questionIndex + 1}
                      </span>
                      <h3>{question.question}</h3>

                      {question.options.map((option, optionIndex) => {
                        const isSelected = quizAnswers[questionIndex] === optionIndex;
                        const result = !quizChecked
                          ? ""
                          : optionIndex === question.correct_index
                            ? "correct"
                            : isSelected
                              ? "incorrect"
                              : "";

                        return (
                          <label
                            className={`quiz-option ${result}`}
                            key={`${option}-${optionIndex}`}
                          >
                            <input
                              type="radio"
                              name={`question-${questionIndex}`}
                              checked={isSelected}
                              disabled={quizChecked}
                              onChange={() =>
                                setQuizAnswers((previousAnswers) => ({
                                  ...previousAnswers,
                                  [questionIndex]: optionIndex,
                                }))
                              }
                            />
                            {option}
                          </label>
                        );
                      })}

                      {quizChecked && (
                        <p>
                          <strong>
                            {quizAnswers[questionIndex] === question.correct_index
                              ? "Correct. "
                              : `Incorrect — the answer is "${
                                  question.options[question.correct_index]
                                }". `}
                          </strong>
                          {question.explanation}
                        </p>
                      )}
                      {quizChecked && question.page && (
                        <small>Source: Page {question.page}</small>
                      )}
                    </article>
                  ))}
                </div>

                {quizChecked ? (
                  <p className="quiz-score" role="status">
                    Score: {quizScore} / {quiz.questions.length}
                  </p>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      Object.keys(quizAnswers).length < quiz.questions.length
                    }
                    onClick={handleCheckAnswers}
                  >
                    Check answers
                  </button>
                )}
              </>
            )}

            <button
              className="secondary-button"
              onClick={() => setActivePage("dashboard")}
            >
              Back to Dashboard
            </button>
          </section>
        ) : activePage === "progress" ? (
          <section className="study-material-card">
            <div className="feature-icon green">↗</div>
            <h2>My Progress</h2>
            <p>Results from the quizzes you have completed in this browser.</p>

            {progressError && (
              <p className="file-error" role="alert">
                {progressError}
              </p>
            )}

            {!progressSummary ? (
              <div className="progress-empty">
                <p>
                  No quizzes completed yet. Generate a quiz from your lecture
                  and click &quot;Check answers&quot; to record your first result.
                </p>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => setActivePage("quizzes")}
                >
                  Take a quiz
                </button>
              </div>
            ) : (
              <>
                <div className="progress-stats">
                  <div className="progress-stat">
                    <span>Quizzes completed</span>
                    <strong>{progressSummary.completed}</strong>
                  </div>
                  <div className="progress-stat">
                    <span>Average score</span>
                    <strong>{progressSummary.averagePercent}%</strong>
                  </div>
                  <div className="progress-stat">
                    <span>Best score</span>
                    <strong>{progressSummary.bestPercent}%</strong>
                  </div>
                  <div className="progress-stat">
                    <span>Questions correct</span>
                    <strong>
                      {progressSummary.totalCorrect} / {progressSummary.totalQuestions}
                    </strong>
                  </div>
                </div>

                <h3 className="progress-heading">By lecture</h3>
                <div className="progress-list">
                  {progressSummary.lectures.map((lecture) => (
                    <div className="progress-row" key={lecture.name}>
                      <div>
                        <strong>{lecture.name}</strong>
                        <p>
                          {lecture.quizzes} {lecture.quizzes === 1 ? "quiz" : "quizzes"}
                          {" · "}
                          {lecture.correct} / {lecture.total} correct
                        </p>
                      </div>
                      <div className="progress-meter" aria-hidden="true">
                        <span style={{ width: `${lecture.percent}%` }} />
                      </div>
                      <strong>{lecture.percent}%</strong>
                    </div>
                  ))}
                </div>

                <h3 className="progress-heading">Recent activity</h3>
                <div className="progress-list">
                  {quizResults.slice(0, 10).map((result) => (
                    <div className="progress-row" key={result.id}>
                      <div>
                        <strong>{result.lectureName || "Unnamed lecture"}</strong>
                        <p>
                          {formatDate(result.completedAt)}
                          {result.topic ? ` · Topic: ${result.topic}` : " · Whole lecture"}
                        </p>
                      </div>
                      <strong>
                        {result.correct} / {result.total} (
                        {percentOf(result.correct, result.total)}%)
                      </strong>
                    </div>
                  ))}
                </div>

                <button
                  className="secondary-button"
                  type="button"
                  onClick={clearProgress}
                >
                  Clear progress
                </button>
              </>
            )}

            <button
              className="secondary-button"
              onClick={() => setActivePage("dashboard")}
            >
              Back to Dashboard
            </button>
          </section>
        ) : (
          <section className="placeholder-card">
            <div className="feature-icon purple">✳</div>
            <h2>
              {menuItems.find((item) => item.id === activePage)?.label}
            </h2>
            <p>
              This section is ready for us to build next. We will connect
              it to the AI backend step by step.
            </p>
            <button
              className="secondary-button"
              onClick={() => setActivePage("dashboard")}
            >
              Back to Dashboard
            </button>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;

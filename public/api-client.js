/* ============================================
   ACADEMIA HUB — API Client (Phase 2)
   Drop-in service layer replacing localStorage.
   Include in index.html: <script src="api-client.js"></script>
   ============================================ */
const API = (() => {
  const TOKEN_KEY = "academia_token";
  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const setToken = (t) => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

  async function call(method, path, body) {
    const headers = { "content-type": "application/json" };
    const token = getToken();
    if (token) headers.authorization = "Bearer " + token;
    const res = await fetch("/api" + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || res.statusText);
      e.status = res.status;
      throw e;
    }
    return data;
  }

  /* Read a File object as base64 (for submissions) */
  const fileToBase64 = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(new Error("File read failed"));
    r.readAsDataURL(file);
  });

  return {
    getToken, setToken, fileToBase64,

    /* Auth */
    signup: (email, password, name, role, studentId) =>
      call("POST", "/auth/signup", { email, password, name, role, studentId })
        .then(d => { setToken(d.token); return d.user; }),
    login: (email, password) =>
      call("POST", "/auth/login", { email, password })
        .then(d => { setToken(d.token); return d.user; }),
    logout: () => setToken(null),
    me: () => call("GET", "/auth/me").then(d => d.user),

    /* Courses */
    courses: () => call("GET", "/courses").then(d => d.courses),
    createCourse: (p) => call("POST", "/courses", p).then(d => d.course),
    joinCourse: (joinCode) => call("POST", "/courses/join", { joinCode }).then(d => d.course),
    people: (courseId) => call("GET", `/courses/${courseId}/people`).then(d => d.students),
    removeStudent: (courseId, studentId) => call("DELETE", `/courses/${courseId}/students/${studentId}`),

    /* Announcements */
    announcements: (courseId) => call("GET", `/courses/${courseId}/announcements`).then(d => d.announcements),
    postAnnouncement: (courseId, content) => call("POST", `/courses/${courseId}/announcements`, { content }),

    /* Assignments & submissions */
    assignments: (courseId) => call("GET", `/courses/${courseId}/assignments`).then(d => d.assignments),
    createAssignment: (courseId, p) => call("POST", `/courses/${courseId}/assignments`, p).then(d => d.assignment),
    extendAssignment: (assignmentId, closeDate, studentId) =>
      call("POST", `/assignments/${assignmentId}/extend`, { closeDate, studentId }),
    submissions: (assignmentId) => call("GET", `/assignments/${assignmentId}/submissions`),
    submit: async (assignmentId, fileList, textAnswer) => {
      const files = [];
      for (const f of Array.from(fileList).slice(0, 5)) {
        files.push({ name: f.name, type: f.type, base64: await fileToBase64(f) });
      }
      return call("POST", `/assignments/${assignmentId}/submissions`, { files, textAnswer });
    },
    grade: (submissionId, grade, feedback) =>
      call("POST", `/submissions/${submissionId}/grade`, { grade, feedback }),
    fileUrl: (submissionId, index) => `/api/submissions/${submissionId}/file/${index}`,

    /* Exams */
    exams: (courseId) => call("GET", `/courses/${courseId}/exams`).then(d => d.exams),
    createExam: (courseId, p) => call("POST", `/courses/${courseId}/exams`, p).then(d => d.exam),
    saveQuestions: (examId, questions) => call("PUT", `/exams/${examId}/questions`, { questions }).then(d => d.exam),
    startAttempt: (examId) => call("POST", `/exams/${examId}/attempt`),
    saveAnswers: (attemptId, answers) => call("PUT", `/attempts/${attemptId}`, { answers }),
    submitAttempt: (attemptId, answers) => call("POST", `/attempts/${attemptId}/submit`, { answers }),

    /* Content modules */
    modules: (courseId) => call("GET", `/courses/${courseId}/modules`).then(d => d.modules),
    createModule: (courseId, title) => call("POST", `/courses/${courseId}/modules`, { title }).then(d => d.module),
    updateModule: (moduleId, patch) => call("PUT", `/modules/${moduleId}`, patch).then(d => d.module),
    deleteModule: (moduleId) => call("DELETE", `/modules/${moduleId}`),

    /* Discussions */
    discussions: (courseId) => call("GET", `/courses/${courseId}/discussions`).then(d => d.discussions),
    createDiscussion: (courseId, title, body) =>
      call("POST", `/courses/${courseId}/discussions`, { title, body }).then(d => d.discussion),
    replies: (discussionId) => call("GET", `/discussions/${discussionId}/replies`).then(d => d.replies),
    reply: (discussionId, content) => call("POST", `/discussions/${discussionId}/replies`, { content }),

    /* Messages */
    contacts: () => call("GET", "/messages/contacts").then(d => d.contacts),
    conversation: (userId) => call("GET", `/messages/${userId}`).then(d => d.messages),
    sendMessage: (toId, content) => call("POST", "/messages", { toId, content }),

    /* Attendance */
    attendance: (courseId) => call("GET", `/courses/${courseId}/attendance`).then(d => d.sessions),
    saveAttendance: (courseId, date, records) =>
      call("POST", `/courses/${courseId}/attendance`, { date, records }),

    /* Notifications */
    notifications: () => call("GET", "/notifications").then(d => d.notifications),
    markRead: (ids) => call("POST", "/notifications/read", ids ? { ids } : {})
  };
})();

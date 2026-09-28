import { Component, type ReactNode } from "react";
import { reportBrowserFailure } from "./observability";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    reportBrowserFailure(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const arabic = document.documentElement.lang === "ar";
    return (
      <main className="center-state" role="alert" dir={arabic ? "rtl" : "ltr"}>
        <h1>
          {arabic ? "تعذر عرض الصفحة" : "This page could not be displayed"}
        </h1>
        <p>
          {arabic
            ? "أعد تحميل الصفحة للمحاولة مجددًا. قد تحتاج إلى اختيار الملف مرة أخرى إذا لم يكتمل رفعه."
            : "Reload to try again. You may need to select your file again if its upload did not finish."}
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          {arabic ? "إعادة تحميل الصفحة" : "Reload page"}
        </button>
      </main>
    );
  }
}

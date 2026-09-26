import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
void import("./App")
  .then(({ default: App }) =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
  .catch(() => {
    const arabic = navigator.language.toLowerCase().startsWith("ar");
    document.documentElement.lang = arabic ? "ar" : "en";
    document.documentElement.dir = arabic ? "rtl" : "ltr";
    root.render(
      <main className="center-state" role="alert">
        {arabic
          ? "تعذر إعداد ميوزك ميوت. حدّث الصفحة أو حاول لاحقًا."
          : "MusicMute is unavailable. Refresh the page or try again later."}
      </main>,
    );
  });

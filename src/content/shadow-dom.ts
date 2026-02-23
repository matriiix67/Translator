import type { TranslationStyle } from "@shared/types";

export interface TranslationMount {
  appendChunk: (chunk: string) => void;
  setText: (text: string) => void;
  setLoading: () => void;
  setError: (message: string) => void;
  remove: () => void;
}

function createTemplate(style: TranslationStyle): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-role", "translation-wrapper");
  wrapper.style.fontFamily =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  wrapper.style.marginTop = "8px";
  wrapper.style.padding = "8px 10px";
  wrapper.style.background = style.backgroundColor;
  wrapper.style.color = style.color;
  wrapper.style.borderLeft = `3px solid ${style.borderColor}`;
  wrapper.style.borderRadius = "6px";
  wrapper.style.lineHeight = "1.5";
  wrapper.style.fontSize = style.fontSize;
  wrapper.style.whiteSpace = "pre-wrap";
  wrapper.style.wordBreak = "break-word";
  wrapper.style.boxSizing = "border-box";
  wrapper.style.position = "relative";
  wrapper.style.zIndex = "2147483000";
  wrapper.textContent = "";
  return wrapper;
}

function removeStaleSiblingHosts(target: HTMLElement): void {
  let sibling = target.nextElementSibling as HTMLElement | null;
  while (sibling?.classList.contains("ai-translator-host")) {
    const next = sibling.nextElementSibling as HTMLElement | null;
    sibling.remove();
    sibling = next;
  }
}

export function mountTranslationAfter(
  target: HTMLElement,
  style: TranslationStyle
): TranslationMount {
  removeStaleSiblingHosts(target);
  const host = document.createElement("span");
  host.className = "ai-translator-host";
  host.setAttribute("aria-live", "polite");
  target.insertAdjacentElement("afterend", host);

  const shadow = host.attachShadow({ mode: "closed" });
  const wrapper = createTemplate(style);
  shadow.appendChild(wrapper);

  let current = "";

  return {
    setLoading: () => {
      current = "";
      wrapper.style.opacity = "0.75";
      wrapper.textContent = "翻译中...";
    },
    appendChunk: (chunk: string) => {
      if (!chunk) {
        return;
      }
      if (wrapper.textContent === "翻译中...") {
        current = "";
      }
      current += chunk;
      wrapper.style.opacity = "1";
      wrapper.textContent = current;
    },
    setText: (text: string) => {
      current = text;
      wrapper.style.opacity = "1";
      wrapper.textContent = text || "（空译文）";
    },
    setError: (message: string) => {
      wrapper.style.opacity = "1";
      wrapper.style.background = "#fff6f6";
      wrapper.style.color = "#a62121";
      wrapper.style.borderLeft = "3px solid #e66";
      wrapper.textContent = message;
    },
    remove: () => {
      host.remove();
    }
  };
}

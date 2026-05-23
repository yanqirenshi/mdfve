import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { marked } from "marked";
import Prism from "prismjs";

// Prism の主要な言語ハイライト定義を読み込む
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-css";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-markdown";

// ==========================================
// 状態管理用変数
// ==========================================
let currentFilePath: string | null = null;
let isDirty = false;
let isAutosaveEnabled = true;
let autoSaveTimeout: number | undefined;

// DOM 要素への参照
let editorEl: HTMLTextAreaElement;
let previewEl: HTMLElement;
let previewPaneEl: HTMLElement;
let editorPaneEl: HTMLElement;
let fileTitleEl: HTMLElement | null = null;
let dirtyIndicatorEl: HTMLElement | null = null;
let filepathDisplayEl: HTMLElement;
let charCountEl: HTMLElement;
let wordCountEl: HTMLElement;
let readTimeEl: HTMLElement;
let autosaveStatusEl: HTMLElement;
let activeThemeEl: HTMLElement;
let outlineSidebarEl: HTMLElement;
let outlineListEl: HTMLElement;
let workspaceEl: HTMLElement;
let btnFloatingOutlineEl: HTMLElement;
let btnCloseSidebarEl: HTMLElement;

// ==========================================
// Markdown レンダリング ＆ 統計情報更新
// ==========================================
async function renderMarkdown() {
  const markdownText = editorEl.value;
  // marked で HTML を生成
  const htmlContent = await marked.parse(markdownText);
  previewEl.innerHTML = htmlContent;

  // PrismJS を用いてコードブロックをシンタックスハイライト
  Prism.highlightAllUnder(previewEl);

  // 目次（アウトライン）の更新
  updateOutline();
}

function updateStats() {
  const text = editorEl.value;
  // 空白を除いた文字数
  const charCount = text.replace(/\s/g, "").length;
  // 単語数
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  // 読了目安 (一般的な読書速度: 1分間に約600文字として計算)
  const readTime = Math.ceil(charCount / 600);

  charCountEl.textContent = `${charCount} 文字`;
  wordCountEl.textContent = `${wordCount} 単語`;
  readTimeEl.textContent = `読了目安: ${readTime} 分`;
}

async function updateFileTitle() {
  const fileName = currentFilePath
    ? currentFilePath.split(/[/\\]/).pop() || "無題.md"
    : "無題.md";
  if (fileTitleEl) {
    fileTitleEl.textContent = fileName;
  }
  filepathDisplayEl.textContent = currentFilePath || "新規ファイル";

  // Tauriのウィンドウタイトルを更新 (MDFVE - <ファイル名> *)
  try {
    const appWindow = getCurrentWindow();
    const dirtySuffix = isDirty ? " *" : "";
    await appWindow.setTitle(`MDFVE - ${fileName}${dirtySuffix}`);
  } catch (e) {
    console.error("Failed to set window title:", e);
  }
}

function markAsDirty(dirty: boolean) {
  isDirty = dirty;
  if (dirty) {
    if (dirtyIndicatorEl) {
      dirtyIndicatorEl.classList.remove("hidden");
    }
    if (currentFilePath && isAutosaveEnabled) {
      updateAutoSaveStatus("saving");
    } else {
      updateAutoSaveStatus("dirty");
    }
  } else {
    if (dirtyIndicatorEl) {
      dirtyIndicatorEl.classList.add("hidden");
    }
    updateAutoSaveStatus(currentFilePath ? "saved" : "off");
  }
  // 未保存状態をウィンドウタイトルに即座に反映
  updateFileTitle();
}

function updateAutoSaveStatus(state: "off" | "saving" | "saved" | "dirty") {
  autosaveStatusEl.className = "status-indicator";
  
  if (!isAutosaveEnabled || !currentFilePath) {
    autosaveStatusEl.textContent = "自動保存: オフ";
    return;
  }

  switch (state) {
    case "saving":
      autosaveStatusEl.classList.add("saving");
      autosaveStatusEl.textContent = "自動保存: 保存中...";
      break;
    case "saved":
      autosaveStatusEl.classList.add("saved");
      autosaveStatusEl.textContent = "自動保存: 保存済み";
      break;
    case "dirty":
      autosaveStatusEl.classList.add("dirty");
      autosaveStatusEl.textContent = "自動保存: 未保存の変更あり";
      break;
  }
}

// ==========================================
// 動的目次 (TOC) 生成
// ==========================================
function updateOutline() {
  outlineListEl.innerHTML = "";
  const headers = previewEl.querySelectorAll("h1, h2, h3, h4, h5, h6");

  if (headers.length === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "outline-item";
    emptyMsg.style.color = "var(--text-secondary)";
    emptyMsg.style.fontStyle = "italic";
    emptyMsg.textContent = "見出しがありません";
    outlineListEl.appendChild(emptyMsg);
    return;
  }

  headers.forEach((header, index) => {
    const id = `heading-${index}`;
    header.setAttribute("id", id);

    const link = document.createElement("a");
    link.className = `outline-item ${header.tagName.toLowerCase()}`;
    link.textContent = header.textContent || "";
    
    // スムーズスクロール
    link.addEventListener("click", (e) => {
      e.preventDefault();
      header.scrollIntoView({ behavior: "smooth" });
    });

    outlineListEl.appendChild(link);
  });
}

// ==========================================
// ファイル入出力処理
// ==========================================
async function saveFileContent(path: string) {
  const content = editorEl.value;
  await writeTextFile(path, content);
}

async function handleNewFile() {
  if (isDirty) {
    const confirmDiscard = await ask("未保存の変更があります。変更を破棄して新しいファイルを作成しますか？", {
      title: "確認",
      kind: "warning",
      okLabel: "はい",
      cancelLabel: "いいえ"
    });
    if (!confirmDiscard) return;
  }

  editorEl.value = "";
  currentFilePath = null;
  markAsDirty(false);
  updateFileTitle();
  renderMarkdown();
  updateStats();
  editorEl.focus();
}

async function handleOpenFile() {
  if (isDirty) {
    const confirmDiscard = await ask("未保存の変更があります。変更を破棄して別のファイルを開きますか？", {
      title: "確認",
      kind: "warning",
      okLabel: "はい",
      cancelLabel: "いいえ"
    });
    if (!confirmDiscard) return;
  }

  try {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Markdown",
          extensions: ["md", "markdown", "txt"]
        }
      ]
    });

    if (selected && typeof selected === "string") {
      const content = await readTextFile(selected);
      editorEl.value = content;
      currentFilePath = selected;
      markAsDirty(false);
      updateFileTitle();
      renderMarkdown();
      updateStats();
    }
  } catch (e) {
    console.error("Failed to open file", e);
  }
}

async function handleSaveFile() {
  if (!currentFilePath) {
    await handleSaveAsFile();
    return;
  }

  try {
    await saveFileContent(currentFilePath);
    markAsDirty(false);
  } catch (e) {
    console.error("Failed to save file", e);
  }
}

async function handleSaveAsFile() {
  try {
    const path = await save({
      filters: [
        {
          name: "Markdown",
          extensions: ["md"]
        }
      ],
      defaultPath: currentFilePath || "無題.md"
    });

    if (path) {
      currentFilePath = path;
      await saveFileContent(path);
      markAsDirty(false);
      updateFileTitle();
    }
  } catch (e) {
    console.error("Failed to save as file", e);
  }
}

// ==========================================
// 同期スクロールロジック
// ==========================================
let isScrollingEditor = false;
let isScrollingPreview = false;

function setupSyncScroll() {
  editorEl.addEventListener("scroll", () => {
    if (isScrollingPreview) {
      isScrollingPreview = false;
      return;
    }
    isScrollingEditor = true;
    
    // スクロール比率を計算
    const scrollRange = editorEl.scrollHeight - editorEl.clientHeight;
    if (scrollRange > 0) {
      const percentage = editorEl.scrollTop / scrollRange;
      const previewScrollRange = previewPaneEl.scrollHeight - previewPaneEl.clientHeight;
      previewPaneEl.scrollTop = percentage * previewScrollRange;
    }
  });

  previewPaneEl.addEventListener("scroll", () => {
    if (isScrollingEditor) {
      isScrollingEditor = false;
      return;
    }
    isScrollingPreview = true;
    
    // スクロール比率を計算
    const scrollRange = previewPaneEl.scrollHeight - previewPaneEl.clientHeight;
    if (scrollRange > 0) {
      const percentage = previewPaneEl.scrollTop / scrollRange;
      const editorScrollRange = editorEl.scrollHeight - editorEl.clientHeight;
      editorEl.scrollTop = percentage * editorScrollRange;
    }
  });
}

// ==========================================
// イベントハンドラ ＆ UI 初期化
// ==========================================
function setupUI() {
  // フローティングポップアップメニューの表示制御
  const btnMenuFile = document.getElementById("btn-menu-file")!;
  const btnMenuView = document.getElementById("btn-menu-view")!;
  const btnMenuTheme = document.getElementById("btn-menu-theme")!;

  const popupFile = document.getElementById("popup-file")!;
  const popupView = document.getElementById("popup-view")!;
  const popupTheme = document.getElementById("popup-theme")!;

  const closeAllPopups = () => {
    popupFile.classList.add("hidden");
    popupView.classList.add("hidden");
    popupTheme.classList.add("hidden");

    btnMenuFile.classList.remove("active");
    btnMenuView.classList.remove("active");
    btnMenuTheme.classList.remove("active");
  };

  const togglePopup = (popup: HTMLElement, btn: HTMLElement) => {
    const isHidden = popup.classList.contains("hidden");
    closeAllPopups();
    if (isHidden) {
      popup.classList.remove("hidden");
      btn.classList.add("active");
    }
  };

  btnMenuFile.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopup(popupFile, btnMenuFile);
  });

  btnMenuView.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopup(popupView, btnMenuView);
  });

  btnMenuTheme.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopup(popupTheme, btnMenuTheme);
  });

  // ポップアップ自体のクリックで閉じないように制御
  popupFile.addEventListener("click", (e) => e.stopPropagation());
  popupView.addEventListener("click", (e) => e.stopPropagation());
  popupTheme.addEventListener("click", (e) => e.stopPropagation());

  // 画面全体のクリックでポップアップを閉じる
  document.addEventListener("click", () => {
    closeAllPopups();
  });

  // 各ポップアップ内アイテムがクリックされたらポップアップを閉じる (トグルボタン以外)
  const popupItems = document.querySelectorAll(".popup-item");
  popupItems.forEach(item => {
    if (item.id === "btn-toggle-width" || item.id === "btn-toggle-outline") {
      return;
    }
    item.addEventListener("click", () => {
      setTimeout(closeAllPopups, 120);
    });
  });

  // ツールバーボタンイベント
  document.getElementById("btn-new")?.addEventListener("click", handleNewFile);
  document.getElementById("btn-open")?.addEventListener("click", handleOpenFile);
  document.getElementById("btn-save")?.addEventListener("click", handleSaveFile);
  document.getElementById("btn-saveas")?.addEventListener("click", handleSaveAsFile);

  // 表示切り替えボタン
  const btnEditor = document.getElementById("btn-view-editor")!;
  const btnSplit = document.getElementById("btn-view-split")!;
  const btnPreview = document.getElementById("btn-view-preview")!;

  const setViewMode = (mode: "editor" | "split" | "preview") => {
    workspaceEl.classList.remove("mode-editor", "mode-preview");
    btnEditor.classList.remove("active");
    btnSplit.classList.remove("active");
    btnPreview.classList.remove("active");

    if (mode === "editor") {
      workspaceEl.classList.add("mode-editor");
      btnEditor.classList.add("active");
    } else if (mode === "preview") {
      workspaceEl.classList.add("mode-preview");
      btnPreview.classList.add("active");
    } else {
      // split モード
      btnSplit.classList.add("active");
    }
  };

  btnEditor.addEventListener("click", () => {
    setViewMode("editor");
  });
  btnSplit.addEventListener("click", () => {
    setViewMode("split");
  });
  btnPreview.addEventListener("click", () => {
    setViewMode("preview");
  });
  
  // 初期表示は分割表示
  setViewMode("split");

  // 目次の表示/非表示トグル
  const btnToggleOutline = document.getElementById("btn-toggle-outline")!;

  const setOutlineVisibility = (visible: boolean) => {
    if (visible) {
      outlineSidebarEl.classList.remove("hidden");
      btnToggleOutline.classList.add("active");
      btnFloatingOutlineEl.classList.add("hidden");
    } else {
      outlineSidebarEl.classList.add("hidden");
      btnToggleOutline.classList.remove("active");
      btnFloatingOutlineEl.classList.remove("hidden");
    }
  };

  btnToggleOutline.addEventListener("click", () => {
    const isHidden = outlineSidebarEl.classList.contains("hidden");
    setOutlineVisibility(isHidden);
  });

  btnFloatingOutlineEl.addEventListener("click", () => {
    setOutlineVisibility(true);
  });

  btnCloseSidebarEl.addEventListener("click", () => {
    setOutlineVisibility(false);
  });

  // テーマ切り替え (吹き出し内のボタン)
  const themeOptions = document.querySelectorAll(".theme-option");
  themeOptions.forEach(btn => {
    btn.addEventListener("click", () => {
      const selectedTheme = btn.getAttribute("data-theme")!;
      // 既存の theme- クラスを除去して追加
      const classes = Array.from(workspaceEl.parentElement?.classList || []);
      classes.forEach(c => {
        if (c.startsWith("theme-")) workspaceEl.parentElement?.classList.remove(c);
      });
      workspaceEl.parentElement?.classList.add(selectedTheme);
      
      // アクティブ状態の更新
      themeOptions.forEach(opt => opt.classList.remove("active"));
      btn.classList.add("active");
      
      // ステータスバー表示の更新
      const themeLabel = btn.querySelector("span:not(.theme-color-preview)")?.textContent || "";
      activeThemeEl.textContent = themeLabel;
    });
  });
  
  // デフォルトテーマ適用 (ライトテーマ)
  workspaceEl.parentElement?.classList.add("theme-light");
  activeThemeEl.textContent = "ライトテーマ";
  document.querySelector('.theme-option[data-theme="theme-light"]')?.classList.add("active");

  // 表示幅切り替え (プレビュー用)
  const btnToggleWidth = document.getElementById("btn-toggle-width")!;
  const widthLabel = document.getElementById("width-label")!;
  btnToggleWidth.addEventListener("click", () => {
    previewEl.classList.toggle("wide-preview");
    if (previewEl.classList.contains("wide-preview")) {
      widthLabel.textContent = "広い幅";
      btnToggleWidth.classList.add("active");
    } else {
      widthLabel.textContent = "標準幅";
      btnToggleWidth.classList.remove("active");
    }
  });

  // ドラッグリサイズバーの実装
  const dragBar = document.getElementById("drag-bar")!;
  dragBar.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragBar.classList.add("dragging");

    const doDrag = (moveEvent: MouseEvent) => {
      const workspaceRect = workspaceEl.getBoundingClientRect();
      const sidebarWidth = outlineSidebarEl.classList.contains("hidden") ? 0 : 260;
      
      const relativeX = moveEvent.clientX - workspaceRect.left - sidebarWidth;
      const totalWidth = workspaceRect.width - sidebarWidth - 6; // 6px はドラッグバー幅
      
      if (totalWidth > 0) {
        let percentage = (relativeX / totalWidth) * 100;
        // 限界値を設定
        if (percentage < 15) percentage = 15;
        if (percentage > 85) percentage = 85;

        editorPaneEl.style.flex = "none";
        editorPaneEl.style.width = `${percentage}%`;
      }
    };

    const stopDrag = () => {
      dragBar.classList.remove("dragging");
      window.removeEventListener("mousemove", doDrag);
      window.removeEventListener("mouseup", stopDrag);
    };

    window.addEventListener("mousemove", doDrag);
    window.addEventListener("mouseup", stopDrag);
  });

  // キーボードショートカット
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      handleNewFile();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      handleOpenFile();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      handleSaveAsFile();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      handleSaveFile();
    }
  });

  // テキストエリア入力イベント (自動保存タイマー始動、Markdownレンダリング)
  editorEl.addEventListener("input", () => {
    markAsDirty(true);
    updateStats();
    renderMarkdown();

    // 自動保存処理
    if (currentFilePath && isAutosaveEnabled) {
      clearTimeout(autoSaveTimeout);
      autoSaveTimeout = setTimeout(async () => {
        try {
          await saveFileContent(currentFilePath!);
          markAsDirty(false);
        } catch (e) {
          console.error("Auto-save failed", e);
          updateAutoSaveStatus("dirty");
        }
      }, 1500) as unknown as number;
    }
  });
}

// アプリケーションロード時の初期処理
window.addEventListener("DOMContentLoaded", async () => {
  // DOM の関連付け
  editorEl = document.getElementById("editor") as HTMLTextAreaElement;
  previewEl = document.getElementById("preview")!;
  previewPaneEl = document.getElementById("preview-pane")!;
  editorPaneEl = document.getElementById("editor-pane")!;
  fileTitleEl = document.getElementById("file-title");
  dirtyIndicatorEl = document.getElementById("dirty-indicator");
  filepathDisplayEl = document.getElementById("filepath-display")!;
  charCountEl = document.getElementById("char-count")!;
  wordCountEl = document.getElementById("word-count")!;
  readTimeEl = document.getElementById("read-time")!;
  autosaveStatusEl = document.getElementById("autosave-status")!;
  activeThemeEl = document.getElementById("active-theme")!;
  outlineSidebarEl = document.getElementById("outline-sidebar")!;
  outlineListEl = document.getElementById("outline-list")!;
  workspaceEl = document.querySelector(".workspace")!;
  btnFloatingOutlineEl = document.getElementById("btn-floating-outline")!;
  btnCloseSidebarEl = document.getElementById("btn-close-sidebar")!;

  // UI セットアップ
  setupUI();
  setupSyncScroll();

  // 初期プレビュー描画と文字数計算
  renderMarkdown();
  updateStats();
  updateFileTitle();
});

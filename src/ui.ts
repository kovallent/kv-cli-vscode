import * as vscode from "vscode";

export interface Prompt {
  kind: "info" | "warning" | "error";
  text: string;
  detail?: string;
  modal: boolean;
  buttons: string[];
}

export interface RecordedPrompt extends Prompt {
  /** Resolve the prompt as if the user clicked `button` (undefined dismisses). */
  answer(button: string | undefined): void;
  readonly answered: Promise<string | undefined>;
}

/**
 * Every notification and dialog goes through here, so the extension's tests
 * can see what a user would see and answer it. Outside tests it calls the
 * VS Code window API and nothing else.
 */
export class Ui {
  readonly recorded: RecordedPrompt[] = [];
  /** Tests set this to answer prompts as they appear. */
  responder: ((p: Prompt) => string | undefined | "pending") | undefined;
  /** Error notifications on screen now, so one failure shows once. */
  private readonly openErrors = new Set<string>();

  constructor(private readonly testMode: boolean) {}

  show(prompt: Prompt): Promise<string | undefined> {
    if (this.testMode) {
      return this.record(prompt);
    }
    const options: vscode.MessageOptions = { modal: prompt.modal, detail: prompt.detail };
    const fn =
      prompt.kind === "error"
        ? vscode.window.showErrorMessage
        : prompt.kind === "warning"
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
    return Promise.resolve(fn(prompt.text, options, ...prompt.buttons));
  }

  /** An error notification, not repeated while the same one is still open. */
  async showErrorOnce(text: string, buttons: string[] = []): Promise<string | undefined> {
    if (this.openErrors.has(text)) {
      return undefined;
    }
    this.openErrors.add(text);
    try {
      return await this.show({ kind: "error", text, modal: false, buttons });
    } finally {
      this.openErrors.delete(text);
    }
  }

  private record(prompt: Prompt): Promise<string | undefined> {
    let resolve!: (v: string | undefined) => void;
    const answered = new Promise<string | undefined>((r) => (resolve = r));
    let done = false;
    const entry: RecordedPrompt = {
      ...prompt,
      answered,
      answer(button) {
        if (!done) {
          done = true;
          resolve(button);
        }
      },
    };
    this.recorded.push(entry);
    const auto = this.responder?.(prompt);
    if (auto !== "pending" && (this.responder || prompt.modal)) {
      // A modal with no responder is cancelled, as Escape would.
      entry.answer(auto);
    }
    return answered;
  }
}

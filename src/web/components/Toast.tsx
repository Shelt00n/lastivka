import { useStore, createStore } from "../lib/store";

const toastStore = createStore<{ id: number; text: string } | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string) {
  clearTimeout(timer);
  toastStore.set({ id: Date.now(), text });
  timer = setTimeout(() => toastStore.set(null), 3200);
}

export function ToastHost() {
  const current = useStore(toastStore, (s) => s);
  if (!current) return null;
  return (
    <div className="toast" role="status" key={current.id}>
      {current.text}
    </div>
  );
}

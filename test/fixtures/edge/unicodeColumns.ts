const 名前 = '太郎'; export function after(値: number): string { return `${名前}:${値}`; }

export const 挨拶 = (相手: string): string => `こんにちは、${相手}さん 🎉`;

// コメント: 全角文字のみの行も分類対象。
export function mixed(): number {
  const emoji = '🎉🎉';
  return emoji.length + 名前.length;
}

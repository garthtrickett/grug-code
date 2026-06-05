export function calcPrice(price: number): number {
  // original comment here
  const tax = price * 0.1;
  return price + tax;
}
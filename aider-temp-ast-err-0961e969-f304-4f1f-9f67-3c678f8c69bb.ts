export function calcPrice(price: number): number {
  const tax = price * 0.15;
  return price + tax;
// unclosed brace here
  return price + tax;
}

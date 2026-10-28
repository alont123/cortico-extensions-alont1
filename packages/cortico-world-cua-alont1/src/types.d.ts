/** jpeg-js 没有自带类型声明，这里只声明我们用到的形状。 */
declare module 'jpeg-js' {
  const jpeg: {
    encode(data: { data: Uint8Array; width: number; height: number }, quality?: number): { data: Buffer; width: number; height: number };
  };
  export default jpeg;
}

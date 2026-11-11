/**
 * 单文件组件的模块声明。
 *
 * `vue-tsc`（见 package.json 的 build 脚本）会直接把 .vue 编译成 TS 参与类型检查；
 * 而原生 `tsc` 不认识 .vue 扩展名，导入时只会报
 * “Cannot find module './X.vue'”。本声明让 `tsc --noEmit` 能解析这些导入，
 * 使纯 TS 侧的检查（src/core、tools、tests）不受视图层影响。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

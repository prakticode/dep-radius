import { createRouter, createWebHistory } from "vue-router"
import BlogList from "./pages/BlogList.vue"

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/blog" },
    { path: "/blog/:category?", name: "blog", component: BlogList },
  ],
})

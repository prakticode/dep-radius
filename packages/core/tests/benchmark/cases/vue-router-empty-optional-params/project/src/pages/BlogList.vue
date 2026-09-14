<script setup lang="ts">
import { computed, ref, watchEffect } from "vue"
import { useRoute } from "vue-router"
import { fetchPosts, type Post } from "../api/posts"

const route = useRoute()
const category = computed(() => (route.params.category === "" ? "all" : String(route.params.category)))
const posts = ref<Post[]>([])

watchEffect(async () => {
  posts.value = await fetchPosts(category.value)
})
</script>

<template>
  <h1>Blog</h1>
  <p v-if="posts.length === 0">No posts in this category.</p>
  <article v-for="post in posts" :key="post.slug">
    <h2>{{ post.title }}</h2>
  </article>
</template>

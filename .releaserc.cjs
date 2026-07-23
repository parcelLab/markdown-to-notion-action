module.exports = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        releaseRules: [
          // Pin the major version at v3: breaking changes bump minor, not major,
          // so semantic-release never auto-jumps to v4. Bump the major manually
          // (tag v4.0.0) when a new major line is intentional.
          { breaking: true, release: "minor" },
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { type: "perf", release: "patch" },
        ],
      },
    ],
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/github",
      {
        draftRelease: true,
      },
    ],
  ],
};

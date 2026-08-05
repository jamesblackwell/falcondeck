// Minimal expo-constants mock for tests
const Constants = {
  expoConfig: {
    extra: {
      eas: { projectId: 'test-project-id' },
    },
  },
  easConfig: null as { projectId?: string } | null,
}

export default Constants

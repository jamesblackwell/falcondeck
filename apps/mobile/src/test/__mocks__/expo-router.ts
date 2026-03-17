// Stub expo-router for tests
export function useRouter() {
  return { push: () => {}, replace: () => {}, back: () => {} }
}
export function useLocalSearchParams() { return {} }
export const Stack = ({ children }: any) => children
export const Slot = () => null
export const Drawer = ({ drawerContent, children }: any) => {
  if (drawerContent) drawerContent()
  return children
}

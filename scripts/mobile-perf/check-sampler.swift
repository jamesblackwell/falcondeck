import Darwin

// Compile with the production sampler source; Expo bindings are conditional.
@main
struct SamplerRegression {
  static func main() {
    let port = mach_thread_self()
    defer { mach_port_deallocate(mach_task_self_, port) }
    func refs() -> mach_port_urefs_t {
      var count: mach_port_urefs_t = 0
      precondition(mach_port_get_refs(mach_task_self_, port,
        mach_port_right_t(MACH_PORT_RIGHT_SEND), &count) == KERN_SUCCESS)
      return count
    }
    let before = refs()
    for _ in 0..<1000 {
      let (cpu, threads) = PerformanceSampler.cpuUsage()
      precondition(cpu >= 0 && threads > 0, "CPU sampling failed")
    }
    let after = refs()
    precondition(after == before, "Sampler leaked \(after - before) thread send rights")
    precondition(PerformanceSampler.memoryFootprintBytes() > 0, "Memory sampling failed")
    print("1000 native samples: thread references \(before) → \(after); CPU/memory valid")
  }
}

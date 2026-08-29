import Darwin
import ExpoModulesCore

/**
 * Samples this process's CPU usage and memory footprint using public Mach
 * task APIs (`task_info`/`thread_info` on `mach_task_self_`). Reading your
 * own process's stats is App Store-safe; no private API is involved.
 */
public class FalconDeckPerfModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FalconDeckPerf")

    Function("sample") { () -> [String: Double] in
      let (cpuPercent, threadCount) = Self.cpuUsage()
      return [
        "cpuPercent": cpuPercent,
        "memoryBytes": Self.memoryFootprintBytes(),
        "threadCount": Double(threadCount),
      ]
    }
  }

  /// phys_footprint matches the number Xcode's memory gauge reports.
  private static func memoryFootprintBytes() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size
    )
    let result = withUnsafeMutablePointer(to: &info) { infoPtr in
      infoPtr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { intPtr in
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), intPtr, &count)
      }
    }
    guard result == KERN_SUCCESS else { return -1 }
    return Double(info.phys_footprint)
  }

  /// Sum of per-thread cpu_usage across the task, as a percentage of one
  /// core (so values above 100 mean more than one core busy).
  private static func cpuUsage() -> (Double, Int) {
    var threadList: thread_act_array_t?
    var threadCount = mach_msg_type_number_t(0)
    guard task_threads(mach_task_self_, &threadList, &threadCount) == KERN_SUCCESS,
          let threads = threadList else {
      return (-1, 0)
    }
    defer {
      let size = vm_size_t(Int(threadCount) * MemoryLayout<thread_t>.size)
      vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: threads)), size)
    }

    var totalPercent = 0.0
    for index in 0..<Int(threadCount) {
      var info = thread_basic_info()
      var infoCount = mach_msg_type_number_t(
        MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size
      )
      let result = withUnsafeMutablePointer(to: &info) { infoPtr in
        infoPtr.withMemoryRebound(to: integer_t.self, capacity: Int(infoCount)) { intPtr in
          thread_info(threads[index], thread_flavor_t(THREAD_BASIC_INFO), intPtr, &infoCount)
        }
      }
      guard result == KERN_SUCCESS else { continue }
      if info.flags & TH_FLAGS_IDLE == 0 {
        totalPercent += Double(info.cpu_usage) / Double(TH_USAGE_SCALE) * 100.0
      }
    }
    return (totalPercent, Int(threadCount))
  }
}

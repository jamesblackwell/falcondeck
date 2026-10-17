import Foundation
import Darwin

struct PerformanceSample: Sendable {
    let memory: UInt64
    let cpu: Double
    let threads: Int
    static func current() -> PerformanceSample {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<integer_t>.size)
        let capacity = Int(count)
        _ = withUnsafeMutablePointer(to: &info) { pointer in pointer.withMemoryRebound(to: integer_t.self, capacity: capacity) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) } }
        var list: thread_act_array_t?
        var threadCount: mach_msg_type_number_t = 0
        var cpu = 0.0
        if task_threads(mach_task_self_, &list, &threadCount) == KERN_SUCCESS, let list {
            for index in 0..<Int(threadCount) {
                var thread = thread_basic_info()
                var size = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
                let threadCapacity = Int(size)
                let result = withUnsafeMutablePointer(to: &thread) { pointer in pointer.withMemoryRebound(to: integer_t.self, capacity: threadCapacity) { thread_info(list[index], thread_flavor_t(THREAD_BASIC_INFO), $0, &size) } }
                if result == KERN_SUCCESS, thread.flags & TH_FLAGS_IDLE == 0 { cpu += Double(thread.cpu_usage) / Double(TH_USAGE_SCALE) * 100 }
                mach_port_deallocate(mach_task_self_, list[index])
            }
            vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: list)), vm_size_t(Int(threadCount) * MemoryLayout<thread_t>.stride))
        }
        return PerformanceSample(memory: info.resident_size, cpu: cpu, threads: Int(threadCount))
    }
}

struct ConnectionLogEntry: Identifiable, Sendable {
    let id = UUID()
    let date = Date.now
    let message: String
}

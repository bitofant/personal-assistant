import Foundation
import PACore

@main
struct PA {
    static func main() async {
        do {
            switch try parseCommand(Array(CommandLine.arguments.dropFirst())) {
            case .help:
                print(usage)
            case .testCapture(let options):
                try await testCapture(options)
            }
        } catch let e as UsageError {
            eprint("\(e)\n\n\(usage)")
            exit(2)
        } catch {
            eprint("error: \(error)")
            exit(1)
        }
    }
}

// Swift 6 rejects the C `stderr` global (not concurrency-safe).
func eprint(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

struct SpikeError: Error, CustomStringConvertible {
    let description: String
}

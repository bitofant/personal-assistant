import Testing
@testable import PACore

@Suite struct AudioMixTests {
    private func mix(_ chans: [[Float]]) -> [Float] {
        let frames = chans[0].count
        var out = [Float](repeating: 99, count: frames)
        let ptrs = chans.map { c -> UnsafeMutablePointer<Float> in
            let p = UnsafeMutablePointer<Float>.allocate(capacity: c.count)
            p.initialize(from: c, count: c.count)
            return p
        }
        defer { ptrs.forEach { $0.deallocate() } }
        out.withUnsafeMutableBufferPointer { o in
            downmix(channels: ptrs.map { UnsafePointer($0) }, frames: frames, into: o.baseAddress!)
        }
        return out
    }

    @Test func monoIsCopied() {
        #expect(mix([[0.1, -0.2, 0.3]]) == [0.1, -0.2, 0.3])
    }

    @Test func stereoIsAveragedNotSummedOrLeftOnly() {
        // Right-only signal must survive (AVAudioConverter's default remap would drop it).
        #expect(mix([[0, 0], [0.5, -0.5]]) == [0.25, -0.25])
        // Full-scale in phase stays ≤ 1 (a sum would clip).
        #expect(mix([[1, -1], [1, -1]]) == [1, -1])
    }

    @Test func interleaved() {
        let samples: [Float] = [1, 0, 0.5, 0.5, -1, 1, 0.25]  // trailing partial frame ignored
        var out = [Float](repeating: 99, count: 4)
        let n = samples.withUnsafeBufferPointer { s in
            out.withUnsafeMutableBufferPointer { downmix(interleaved: s, channels: 2, into: $0.baseAddress!) }
        }
        #expect(n == 3)
        #expect(Array(out.prefix(3)) == [0.5, 0.5, 0])
        #expect(out[3] == 99)
    }

    @Test func formatMatchesFluidAudioTarget() {
        #expect(CaptureFormat.sampleRate == 16_000)
        #expect(CaptureFormat.channels == 1)
        #expect(CaptureFormat.bytesPerSecond * 3600 == 230_400_000)
    }
}

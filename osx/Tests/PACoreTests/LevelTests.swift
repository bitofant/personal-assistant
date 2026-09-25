import Testing
@testable import PACore

@Suite struct LevelTests {
    @Test func emptyMeterIsUnknownNotSilent() {
        let m = LevelMeter()
        #expect(m.peakOrNil == nil)
        #expect(m.rms == nil)
        #expect(!m.isAllZeros)
        #expect(formatLevel(label: "mic", meter: m, seconds: nil) == "mic: —, peak —, rms —")
    }

    @Test func zerosAreFlagged() {
        var m = LevelMeter()
        m.add([Float](repeating: 0, count: 480))
        #expect(m.isAllZeros)
        #expect(dbfs(m.peakOrNil) == -120)
        #expect(formatLevel(label: "system", meter: m, seconds: 0.01).contains("all zeros"))
    }

    @Test func peakAndRms() {
        var m = LevelMeter()
        m.add([0.5, -1.0, 0.5, -0.5] as [Float])
        #expect(m.peak == 1.0)
        #expect(dbfs(m.peak) == 0)
        #expect(abs(m.rms! - Float((1.75 / 4).squareRoot())) < 1e-6)
    }
}

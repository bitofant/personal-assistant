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

@Suite struct StreamWarningsTests {
    @Test func warnings() {
        var silent = LevelMeter()
        silent.add([0, 0] as [Float])
        var loud = LevelMeter()
        loud.add([0.5] as [Float])
        #expect(streamWarnings(label: "mic", meter: loud, seconds: 10, writeError: nil).isEmpty)
        #expect(streamWarnings(label: "system", meter: silent, seconds: 10, writeError: nil).first?.contains("all zeros") == true)
        #expect(streamWarnings(label: "mic", meter: LevelMeter(), seconds: nil, writeError: nil) == ["mic: no audio captured"])
        #expect(streamWarnings(label: "mic", meter: loud, seconds: 10, writeError: "disk full") == ["mic: write error: disk full"])
    }
}

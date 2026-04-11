import AVFoundation

final class ThinkingSound {
    private var engine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var timer: Timer?
    private var isPlaying = false

    func start() {
        guard !isPlaying else { return }
        isPlaying = true
        playPulse()
        timer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: true) { [weak self] _ in
            self?.playPulse()
        }
    }

    func stop() {
        isPlaying = false
        timer?.invalidate()
        timer = nil
        engine?.stop()
        engine = nil
        playerNode = nil
    }

    private func playPulse() {
        guard isPlaying else { return }

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let sampleRate: Double = 44100
        let duration: Double = 2.5
        let frameCount = AVAudioFrameCount(sampleRate * duration)

        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }

        buffer.frameLength = frameCount
        guard let channelData = buffer.floatChannelData?[0] else { return }

        // Fill with white noise
        for i in 0..<Int(frameCount) {
            channelData[i] = Float.random(in: -1...1)
        }

        // Bandpass filter: sweep 200->1200->200 Hz
        let eq = AVAudioUnitEQ(numberOfBands: 1)
        let band = eq.bands[0]
        band.filterType = .bandPass
        band.frequency = 200
        band.bandwidth = 1.0
        band.bypass = false

        // Gain envelope
        let mixer = engine.mainMixerNode
        engine.attach(player)
        engine.attach(eq)
        engine.connect(player, to: eq, format: format)
        engine.connect(eq, to: mixer, format: format)
        mixer.outputVolume = 0.025

        do {
            try engine.start()
            player.play()
            player.scheduleBuffer(buffer, completionHandler: nil)

            // Sweep frequency over duration
            let steps = 50
            for step in 0...steps {
                let t = Double(step) / Double(steps)
                let freq: Float
                if t < 0.5 {
                    freq = 200 + Float(t * 2) * 1000 // 200->1200
                } else {
                    freq = 1200 - Float((t - 0.5) * 2) * 1000 // 1200->200
                }
                let delay = t * duration
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    band.frequency = freq
                }
            }

            // Stop after duration
            DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self] in
                player.stop()
                engine.stop()
                if self?.engine === engine {
                    self?.engine = nil
                    self?.playerNode = nil
                }
            }
        } catch {
            print("[ThinkingSound] Engine start failed: \(error)")
        }

        self.engine = engine
        self.playerNode = player
    }
}

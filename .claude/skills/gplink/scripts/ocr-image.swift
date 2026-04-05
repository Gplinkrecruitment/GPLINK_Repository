import AppKit
import Foundation
import Vision

func jsonPrint(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]),
       let string = String(data: data, encoding: .utf8) {
        print(string)
    } else {
        print("{\"text\":\"\",\"metadata\":\"\"}")
    }
}

guard CommandLine.arguments.count >= 2 else {
    jsonPrint(["text": "", "metadata": "No file path provided."])
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: imageURL) else {
    jsonPrint(["text": "", "metadata": "Unable to load image."])
    exit(1)
}

var rect = CGRect.zero
guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    jsonPrint(["text": "", "metadata": "Unable to create CGImage."])
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
    let observations = request.results ?? []
    let lines = observations.compactMap { observation -> String? in
        observation.topCandidates(1).first?.string
    }

    let width = cgImage.width
    let height = cgImage.height
    let metadata = "width \(width), height \(height)"

    jsonPrint([
        "text": lines.joined(separator: "\n"),
        "metadata": metadata,
        "lineCount": lines.count,
    ])
} catch {
    jsonPrint([
        "text": "",
        "metadata": "OCR failed: \(error.localizedDescription)",
    ])
    exit(1)
}

// testgen's transcoder: test sources decoded and encoded with the very charset javac reads them in.
// Run by libs/encoding.ts, compiled once per JDK; Java 8 compatible. The logic is all on the
// TypeScript side — this only does what Node cannot: MS950, GBK, Shift_JIS and the rest, exactly
// as the JDK defines them.
//
//   Transcode decode <charset> <request>  each line "<in>\t<out>": <in> strictly decoded, written to <out> as UTF-8
//   Transcode encode <charset> <request>  each line "<in>\t<out>": <in> (UTF-8) strictly encoded, written to <out>
//   Transcode probe  <charset> <request>  line 1 is a UTF-8 file: the code points in it that do not survive
//                                         an encode and a decode — unmappable, or mapped to another character
//                                         (U+00A5 is 0x5C in Shift_JIS, which javac reads back as a backslash)
//   Transcode check  <charset>            "ok"; "unknown" (no such charset); "notascii" (ASCII is not itself)
//   Transcode info                        the default charset, and the Java specification version
//
// Every line of output starts with "@@tc ", so whatever else the JVM prints on stdout (-Xlog, a
// JAVA_TOOL_OPTIONS agent) is not read as an answer. One line per request line: "OK" or "ERR <reason>".
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CharsetEncoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;

public class Transcode {
  private static PrintStream out;

  private static void answer(String line) {
    out.println("@@tc " + line);
  }

  public static void main(String[] args) throws Exception {
    out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
    if (args[0].equals("info")) {
      answer(Charset.defaultCharset().name());
      answer(System.getProperty("java.specification.version"));
      return;
    }
    if (args[0].equals("check")) {
      Charset cs;
      try {
        cs = Charset.forName(args[1]);
      } catch (Exception e) {
        answer("unknown");
        return;
      }
      if (!cs.canEncode()) {
        answer("notascii");
        return;
      }
      for (int c = 0; c < 0x80; c++) {
        byte[] b = String.valueOf((char) c).getBytes(cs);
        if (b.length != 1 || b[0] != c) {
          answer("notascii");
          return;
        }
      }
      answer("ok");
      return;
    }
    Charset cs = Charset.forName(args[1]);
    List<String> lines = Files.readAllLines(Paths.get(args[2]), StandardCharsets.UTF_8);
    if (args[0].equals("probe")) {
      String text = strictUtf8(Files.readAllBytes(Paths.get(lines.get(0))));
      CharsetEncoder enc = cs.newEncoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT);
      CharsetDecoder dec = cs.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT);
      StringBuilder missing = new StringBuilder();
      for (int i = 0; i < text.length(); ) {
        int cp = text.codePointAt(i);
        String ch = new String(Character.toChars(cp));
        boolean kept;
        try {
          kept = dec.decode(enc.encode(CharBuffer.wrap(ch))).toString().equals(ch);
        } catch (CharacterCodingException e) {
          kept = false;
        }
        if (!kept) missing.append(Integer.toHexString(cp)).append(' ');
        i += Character.charCount(cp);
      }
      answer(missing.toString().trim());
      return;
    }
    for (String line : lines) {
      if (line.isEmpty()) continue;
      String[] p = line.split("\t");
      try {
        byte[] in = Files.readAllBytes(Paths.get(p[0]));
        if (args[0].equals("decode")) {
          CharsetDecoder dec = cs.newDecoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT);
          Files.write(Paths.get(p[1]), dec.decode(ByteBuffer.wrap(in)).toString().getBytes(StandardCharsets.UTF_8));
        } else {
          CharsetEncoder enc = cs.newEncoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT);
          ByteBuffer bytes = enc.encode(CharBuffer.wrap(strictUtf8(in)));
          byte[] b = new byte[bytes.remaining()];
          bytes.get(b);
          Files.write(Paths.get(p[1]), b);
        }
        answer("OK");
      } catch (Exception e) {
        answer("ERR " + e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage().replace('\n', ' ')));
      }
    }
  }

  private static String strictUtf8(byte[] in) throws Exception {
    return StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(in))
        .toString();
  }
}

import 'package:flutter/material.dart';

class NetworkHealthWidget extends StatelessWidget {
  final int latency;
  final double jitter;
  final bool isConnected;

  const NetworkHealthWidget({
    super.key,
    required this.latency,
    required this.jitter,
    required this.isConnected,
  });

  @override
  Widget build(BuildContext context) {
    // Determine status
    Color color;
    String label;
    if (!isConnected) {
      color = Colors.grey;
      label = 'OFFLINE';
    } else if (latency < 10) {
      color = const Color(0xFF00FFA6); // Neon Green
      label = 'OPTIMAL';
    } else if (latency < 50) {
      color = const Color(0xFFFFCC33); // Warning Yellow
      label = 'STABLE';
    } else {
      color = const Color(0xFFE04456); // Critical Red
      label = 'CRITICAL';
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF141414), // Surface dark
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withOpacity(0.3)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Pulse Dot
          TweenAnimationBuilder(
            tween: ColorTween(begin: color.withOpacity(0.5), end: color),
            duration: const Duration(seconds: 1),
            builder: (_, Color? c, __) {
              return Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: c,
                  boxShadow: [
                    BoxShadow(color: c!, blurRadius: 6, spreadRadius: 1),
                  ],
                ),
              );
            },
            onEnd:
                () {}, // Infinite loop usually done with AnimationController, sim for now
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: TextStyle(
                  color: color,
                  fontWeight: FontWeight.bold,
                  fontSize: 10,
                  letterSpacing: 1.5,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                '${latency}ms',
                style: const TextStyle(
                  color: Colors.white,
                  fontFamily: 'Courier', // Monospace
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
